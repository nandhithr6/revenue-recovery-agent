import { describe, expect, it } from 'vitest';
import { HOUR, MINUTE, type CustomerProfile, type LossEvent } from '../domain/types.js';
import { runCase, runCohort } from '../eval/engine.js';
import { score } from '../eval/metrics.js';
import { Ledger } from '../ledger/ledger.js';
import { generateCohort } from '../sim/generator.js';
import { Rng } from '../sim/rng.js';
import { DEFAULT_COSTS, SCENARIO_IDS, getScenario } from '../sim/scenario.js';
import { BASELINE_STRATEGIES } from './baselines.js';
import { createRulesAgent } from './rules-agent.js';
import type { CaseContext } from './types.js';

const agent = createRulesAgent(DEFAULT_COSTS);
const AT = Date.parse('2026-09-01T11:00:00+05:30');

const customer = (over: Partial<CustomerProfile> = {}): CustomerProfile => ({
  id: 'cust_test',
  dndRegistered: false,
  consent: { email: true, sms: true, whatsapp: true, voice: true },
  utcOffsetMinutes: 330,
  respondsToNudge: true,
  ...over,
});

const event = (over: Partial<LossEvent> = {}): LossEvent => ({
  id: 'loss_test',
  lossType: 'payment_failure',
  merchantId: 'merch_001',
  customer: customer(),
  amountPaise: 100_000,
  method: 'card',
  reasonCode: 'bank_technical_error',
  occurredAt: AT,
  ...over,
});

const ctx = (over: Partial<CaseContext> = {}): CaseContext => ({
  event: event(),
  now: AT,
  history: [],
  attemptCount: 0,
  contactCount: 0,
  channelsUsed: [],
  ...over,
});

describe('refuses to waste attempts', () => {
  it('spends zero retries on a fraud-flagged decline', () => {
    const result = runCase(
      event({ reasonCode: 'payment_risk_check_failed', amountPaise: 50_000 }),
      agent,
      DEFAULT_COSTS,
      new Rng(1),
      new Ledger(),
    );
    expect(result.retries).toBe(0);
  });

  it('spends zero retries on an expired card', () => {
    // The defining behaviour: a dead instrument cannot be charged, so every
    // retry is pure waste. Both baselines burn attempts here.
    const result = runCase(
      event({ reasonCode: 'card_expired' }),
      agent,
      DEFAULT_COSTS,
      new Rng(1),
      new Ledger(),
    );
    expect(result.retries).toBe(0);
    expect(result.contacts).toBeGreaterThan(0);
  });

  it('explains the stop rather than silently giving up', () => {
    const result = runCase(
      event({ reasonCode: 'debit_instrument_blocked', amountPaise: 10_000 }),
      agent,
      DEFAULT_COSTS,
      new Rng(1),
      new Ledger(),
    );
    expect(result.stoppedReason).toContain('HARD_DECLINE');
    expect(result.stoppedReason.length).toBeGreaterThan(30);
  });
});

describe('tempo matches the failure reason', () => {
  it('retries abandonment almost immediately', () => {
    // Purchase intent is perishable; waiting an hour loses it.
    const action = agent.decide(ctx({ event: event({ reasonCode: 'payment_cancelled' }) }));
    expect(action.kind).toBe('retry_payment');
    expect(action.delayMs).toBeLessThanOrEqual(5 * MINUTE);
  });

  it('waits most of a day before retrying insufficient funds', () => {
    // Nothing changes in an hour. The balance has to actually be topped up.
    const action = agent.decide(ctx({ event: event({ reasonCode: 'insufficient_funds' }) }));
    expect(action.kind).toBe('retry_payment');
    expect(action.delayMs).toBeGreaterThan(12 * HOUR);
  });

  it('waits for an outage to clear before retrying infrastructure failures', () => {
    const action = agent.decide(ctx({ event: event({ reasonCode: 'gateway_technical_error' }) }));
    expect(action.kind).toBe('retry_payment');
    expect(action.delayMs).toBeGreaterThan(10 * MINUTE);
    expect(action.delayMs).toBeLessThan(2 * HOUR);
  });

  it('does not message the customer about our own infrastructure', () => {
    const result = runCase(
      event({ reasonCode: 'bank_technical_error' }),
      agent,
      DEFAULT_COSTS,
      new Rng(3),
      new Ledger(),
    );
    expect(result.contacts).toBe(0);
  });
});

describe('intrusiveness scales with the money at stake', () => {
  const smallCart = event({ reasonCode: 'card_expired', amountPaise: 40_000 }); // Rs 400
  const bigInvoice = event({ reasonCode: 'card_expired', amountPaise: 5_000_000 }); // Rs 50,000

  it('sends only an email for a small amount', () => {
    const result = runCase(smallCart, agent, DEFAULT_COSTS, new Rng(5), new Ledger());
    const channels = result.history
      .filter((h) => h.action.kind === 'contact_customer' && !h.blockedBy)
      .map((h) => h.action.channel);
    expect(channels).not.toContain('sms');
    expect(channels).not.toContain('voice');
  });

  it('climbs to a louder channel when the amount justifies it', () => {
    const small = runCase(smallCart, agent, DEFAULT_COSTS, new Rng(5), new Ledger());
    const big = runCase(bigInvoice, agent, DEFAULT_COSTS, new Rng(5), new Ledger());
    expect(big.spamPoints).toBeGreaterThan(small.spamPoints);
  });

  it('never escalates a trivial amount to a human', () => {
    const result = runCase(
      event({ reasonCode: 'payment_risk_check_failed', amountPaise: 5_000 }),
      agent,
      DEFAULT_COSTS,
      new Rng(5),
      new Ledger(),
    );
    expect(result.humanEscalations).toBe(0);
  });
});

describe('learns from guardrail blocks', () => {
  it('does not re-propose a channel that was refused', () => {
    // Fixed dunning loops here: it never reads its own history, so it proposes
    // the same blocked email until the engine's step limit stops it.
    const noEmail = customer({
      consent: { email: false, sms: true, whatsapp: true, voice: true },
    });
    const result = runCase(
      event({ reasonCode: 'card_expired', customer: noEmail, amountPaise: 5_000_000 }),
      agent,
      DEFAULT_COSTS,
      new Rng(9),
      new Ledger(),
    );

    const emailAttempts = result.history.filter((h) => h.action.channel === 'email');
    expect(emailAttempts.length).toBeLessThanOrEqual(1);
  });

  it('retries promptly once a nudge has landed', () => {
    const history = [
      {
        at: AT,
        action: {
          kind: 'contact_customer' as const,
          channel: 'email' as const,
          delayMs: 0,
          rationale: 'nudge',
        },
        succeeded: true,
      },
    ];
    const action = agent.decide(
      ctx({ event: event({ reasonCode: 'card_expired' }), history, contactCount: 1 }),
    );
    expect(action.kind).toBe('retry_payment');
    expect(action.delayMs).toBeLessThanOrEqual(10 * MINUTE);
  });
});

/**
 * Scenarios where a baseline is expected to beat the agent.
 *
 * This was `{'bank-outage': ...}` until the loss-type model landed. The agent
 * lost that scenario because the simulator let ANY strategy "retry" an abandoned
 * checkout or an unpaid invoice and be rewarded for it -- so the baselines were
 * collecting revenue for charging people who had never authorised anything,
 * while the agent correctly refused. Once retries on unauthorised loss types
 * were made impossible for everyone, the loss disappeared.
 *
 * Worth stating plainly, because a model change that happens to favour us
 * deserves scrutiny: the fix was applied to the ENGINE, identically for every
 * strategy, and it removed revenue that could not exist on real rails. The agent
 * was not touched. See ENGINEERING-LOG.md entry 7.
 *
 * The map stays here, and empty, on purpose. If a future change makes the agent
 * lose somewhere, this test fails and demands an explanation rather than a
 * quiet re-baseline.
 */
const KNOWN_AGENT_LOSSES: Readonly<Record<string, string>> = {};

describe('beats every baseline on every scenario', () => {
  const start = Date.parse('2026-09-01T00:00:00+05:30');

  it('wins on aggregate across all scenarios', () => {
    let agentTotal = 0;
    const baselineTotals = new Map<string, number>();

    for (const scenarioId of SCENARIO_IDS) {
      const scenario = getScenario(scenarioId);
      const events = generateCohort(scenario, start);
      const seed = scenario.seed + 1;

      agentTotal += score(runCohort(events, agent, DEFAULT_COSTS, seed))
        .netValueAfterAnnoyancePaise;
      for (const baseline of BASELINE_STRATEGIES) {
        const s = score(runCohort(events, baseline, DEFAULT_COSTS, seed));
        baselineTotals.set(
          baseline.id,
          (baselineTotals.get(baseline.id) ?? 0) + s.netValueAfterAnnoyancePaise,
        );
      }
    }

    for (const [, total] of baselineTotals) {
      expect(agentTotal).toBeGreaterThan(total);
    }
  });

  it('loses only where we have documented that it loses', () => {
    // Guards against a silent regression: if the agent starts losing somewhere
    // new, that is a finding to explain, not a number to quietly re-baseline.
    const losses: string[] = [];

    for (const scenarioId of SCENARIO_IDS) {
      const scenario = getScenario(scenarioId);
      const events = generateCohort(scenario, start);
      const seed = scenario.seed + 1;
      const agentScore = score(runCohort(events, agent, DEFAULT_COSTS, seed));

      for (const baseline of BASELINE_STRATEGIES) {
        const baseScore = score(runCohort(events, baseline, DEFAULT_COSTS, seed));
        if (baseScore.netValueAfterAnnoyancePaise >= agentScore.netValueAfterAnnoyancePaise) {
          losses.push(scenarioId);
        }
      }
    }

    expect([...new Set(losses)].sort()).toEqual(Object.keys(KNOWN_AGENT_LOSSES).sort());
  });

  for (const scenarioId of SCENARIO_IDS) {
    const expectedToLose = scenarioId in KNOWN_AGENT_LOSSES;

    it.skipIf(expectedToLose)(`${scenarioId}: highest net value after annoyance`, () => {
      const scenario = getScenario(scenarioId);
      const events = generateCohort(scenario, start);
      const seed = scenario.seed + 1;

      const agentScore = score(runCohort(events, agent, DEFAULT_COSTS, seed));
      for (const baseline of BASELINE_STRATEGIES) {
        const baseScore = score(runCohort(events, baseline, DEFAULT_COSTS, seed));
        expect(agentScore.netValueAfterAnnoyancePaise).toBeGreaterThan(
          baseScore.netValueAfterAnnoyancePaise,
        );
      }
    });

    it(`${scenarioId}: wastes fewer retries per recovery than naive retry`, () => {
      const scenario = getScenario(scenarioId);
      const events = generateCohort(scenario, start);
      const seed = scenario.seed + 1;

      const agentScore = score(runCohort(events, agent, DEFAULT_COSTS, seed));
      const naive = score(runCohort(events, BASELINE_STRATEGIES[1]!, DEFAULT_COSTS, seed));
      expect(agentScore.retriesPerRecovery).toBeLessThan(naive.retriesPerRecovery);
    });

    it(`${scenarioId}: zero compliance violations`, () => {
      const scenario = getScenario(scenarioId);
      const events = generateCohort(scenario, start);
      const metrics = score(runCohort(events, agent, DEFAULT_COSTS, scenario.seed + 1));
      expect(metrics.complianceViolations).toBe(0);
    });
  }
});

describe('integrity', () => {
  it('the agent never imports the simulator ground truth', async () => {
    // If the playbook could read the real recovery curves it would be grading
    // its own exam. This asserts the wall stays up.
    const fs = await import('node:fs/promises');
    const sources = await Promise.all([
      fs.readFile(new URL('./playbook.ts', import.meta.url), 'utf8'),
      fs.readFile(new URL('./rules-agent.ts', import.meta.url), 'utf8'),
    ]);
    for (const src of sources) {
      expect(src).not.toMatch(/from\s+['"].*recovery-model/);
    }
  });
});
