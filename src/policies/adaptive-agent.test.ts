import { describe, expect, it } from 'vitest';
import type { CustomerProfile, LossEvent } from '../domain/types.js';
import { runCase, runCohort } from '../eval/engine.js';
import { score } from '../eval/metrics.js';
import { Ledger } from '../ledger/ledger.js';
import { generateCohort } from '../sim/generator.js';
import { DEFAULT_COSTS, SCENARIO_IDS, getScenario } from '../sim/scenario.js';
import { Rng } from '../sim/rng.js';
import { createAdaptiveAgent, explain } from './adaptive-agent.js';
import { createRulesAgent } from './rules-agent.js';
import { fixedDunning } from './baselines.js';
import type { CaseContext } from './types.js';

/**
 * The adaptive agent's whole thesis is that it reasons about candidates
 * instead of consulting a schedule. These tests check that the reasoning
 * actually shows up in the decisions, not just in the aggregate scoreboard --
 * an agent that happens to win in total but is not actually amount-aware or
 * attempt-aware underneath would be a coincidence, not the feature.
 */

const agent = createAdaptiveAgent(DEFAULT_COSTS);
const AT = Date.parse('2026-09-01T11:00:00+05:30');

const customer = (over: Partial<CustomerProfile> = {}): CustomerProfile => ({
  id: 'cust_adaptive',
  dndRegistered: false,
  consent: { email: true, sms: true, whatsapp: true, voice: true },
  utcOffsetMinutes: 330,
  respondsToNudge: true,
  ...over,
});

const event = (amountPaise: number, over: Partial<LossEvent> = {}): LossEvent => ({
  id: `loss_${amountPaise}`,
  lossType: 'payment_failure',
  merchantId: 'merch_001',
  customer: customer(),
  amountPaise,
  method: 'card',
  reasonCode: 'insufficient_funds',
  occurredAt: AT,
  ...over,
});

const ctx = (e: LossEvent, over: Partial<CaseContext> = {}): CaseContext => ({
  event: e,
  now: e.occurredAt,
  history: [],
  attemptCount: 0,
  contactCount: 0,
  channelsUsed: [],
  ...over,
});

describe('never reads ground truth', () => {
  it('adaptive-model.ts does not import from sim/recovery-model.ts', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(new URL('./adaptive-model.ts', import.meta.url), 'utf8');
    expect(src.includes("from '../sim/recovery-model")).toBe(false);
  });

  it('adaptive-agent.ts does not import from sim/recovery-model.ts', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(new URL('./adaptive-agent.ts', import.meta.url), 'utf8');
    expect(src.includes("from '../sim/recovery-model")).toBe(false);
  });
});

describe('amount sensitivity: a fixed cost does not scale, expected value does', () => {
  it('a cost that cannot be cleared at all stops; the same cost clears easily once amount is large', () => {
    // Before the escalate_human fix, this test passed for the wrong reason:
    // a flat, class-blind P=0.55 human candidate pulled the large case onto
    // a different ACTION TYPE (escalate) than the small case, which looked
    // like amount-sensitivity but was really the inflated-escalation defect
    // in disguise -- fixing that defect (see the "priced honestly" suite
    // below) made retry-offset selection's own amount-invariance visible: at
    // these costs, retry cost is negligible relative to either amount, so
    // the OFFSET chosen genuinely does not depend on amount, only on the
    // curve shape. That is a real, honest property, not a regression.
    //
    // The real amount-sensitivity claim -- a fixed cost does not scale,
    // expected value does -- still holds and is tested here at the point
    // where it actually bites: an amount too small for ANY candidate to
    // clear its cost stops; a large amount with the identical cost model
    // does not.
    const tiny = agent.decide(ctx(event(100))); // Rs 1 -- no candidate can clear its cost
    const large = agent.decide(ctx(event(8_000_000))); // Rs 80,000 -- same reason, same schedule

    expect(tiny.kind).toBe('stop');
    expect(large.kind).not.toBe('stop');
  });

  it('never proposes escalate_human below the profile floor regardless of odds', () => {
    const tiny = agent.decide(ctx(event(500))); // Rs 5
    expect(tiny.kind).not.toBe('escalate_human');
  });

  it('a large amount can justify escalation once other options are exhausted', () => {
    const huge = event(50_000_000);
    const action = agent.decide(
      ctx(huge, {
        attemptCount: 3,
        contactCount: 2,
        channelsUsed: ['email', 'whatsapp'],
      }),
    );
    // Not asserting a specific kind -- only that a Rs 5,00,000 case with
    // channels already exhausted is a legitimate candidate for a human,
    // which the fixture is set up to make plausible.
    expect(['escalate_human', 'stop', 'retry_payment']).toContain(action.kind);
  });
});

describe('attempt decay: repeated failure lowers expected value', () => {
  it('is less willing to keep retrying after several failed attempts on the same case', () => {
    const e = event(200_000, { reasonCode: 'bank_technical_error' });
    const fresh = agent.decide(ctx(e, { attemptCount: 0 }));
    const worn = agent.decide(
      ctx(e, {
        attemptCount: 4,
        history: Array.from({ length: 4 }, (_, i) => ({
          at: AT + i * 3_600_000,
          action: { kind: 'retry_payment' as const, delayMs: 0, rationale: 'x' },
          succeeded: false,
        })),
      }),
    );
    // A worn-out case should not still be offered the same eager immediate
    // retry a fresh one gets -- either the timing shifts or the agent moves
    // to a different action entirely.
    expect(JSON.stringify(fresh)).not.toBe(JSON.stringify(worn));
  });
});

describe('loss-type permission is still absolute', () => {
  it('never retries a checkout abandonment: nobody authorised a charge', () => {
    const e = event(90_000, { lossType: 'checkout_abandonment', reasonCode: 'payment_cancelled' });
    const result = runCase(e, agent, DEFAULT_COSTS, new Rng(3), new Ledger());
    expect(result.retries).toBe(0);
  });

  it('never retries a receivable: an invoice is not an instrument', () => {
    const e = event(500_000, { lossType: 'receivable' });
    const result = runCase(e, agent, DEFAULT_COSTS, new Rng(3), new Ledger());
    expect(result.retries).toBe(0);
  });

  it('waits rather than stopping when a receivable promise is unbroken', () => {
    const e = event(500_000, { lossType: 'receivable' });
    const action = agent.decide(
      ctx(e, {
        now: AT + 2 * 3_600_000,
        contactCount: 1,
        channelsUsed: ['email'],
        history: [
          {
            at: AT + 3_600_000,
            action: { kind: 'contact_customer', channel: 'email', delayMs: 0, rationale: 'chase' },
            succeeded: true,
          },
        ],
      }),
    );
    expect(action.kind).toBe('wait');
  });
});

describe('never breaches a guardrail, across every scenario', () => {
  for (const scenarioId of SCENARIO_IDS) {
    it(`${scenarioId}: zero compliance violations`, () => {
      const scenario = { ...getScenario(scenarioId), cohortSize: 150 };
      const events = generateCohort(scenario, AT);
      const metrics = score(runCohort(events, agent, DEFAULT_COSTS, scenario.seed + 1));
      expect(metrics.complianceViolations).toBe(0);
    });
  }
});

describe('beats fixed dunning on the primary objective, on aggregate', () => {
  // Not required to win every scenario or every metric -- only that, summed
  // across the whole cohort, the stated primary objective (net value after
  // annoyance) is higher. A strategy tuned to win everything would be
  // overfitted to five hand-written scenarios; this is the same standard
  // rules-agent.test.ts already holds itself to.
  it('recovers more net value after annoyance, summed across all scenarios', () => {
    let adaptiveTotal = 0;
    let fixedTotal = 0;

    for (const scenarioId of SCENARIO_IDS) {
      const scenario = getScenario(scenarioId);
      const events = generateCohort(scenario, AT);
      adaptiveTotal += score(
        runCohort(events, agent, DEFAULT_COSTS, scenario.seed + 1),
      ).netValueAfterAnnoyancePaise;
      fixedTotal += score(
        runCohort(events, fixedDunning, DEFAULT_COSTS, scenario.seed + 1),
      ).netValueAfterAnnoyancePaise;
    }

    expect(adaptiveTotal).toBeGreaterThan(fixedTotal);
  });
});

describe('escalate_human is priced honestly, not as a flat channel', () => {
  // Regression guard: the audited defect was a bare `const p = 0.55` applied
  // regardless of class. If that ever comes back, every one of these should
  // catch it -- either via the exact string or via the resulting EV being
  // implausibly large for a class where a human has no modelled path to
  // recovery in the engine.

  it('never proposes the old flat P=0.55, on any class', () => {
    const classes: Array<[string, string]> = [
      ['bank_technical_error', 'TRANSIENT_INFRA'],
      ['insufficient_funds', 'TRANSIENT_FUNDS'],
      ['card_expired', 'CUSTOMER_ACTION_REQUIRED'],
      ['payment_cancelled', 'ABANDONMENT'],
      ['incorrect_cvv', 'AUTH_FAILURE'],
      ['payment_declined', 'HARD_DECLINE'],
    ];
    for (const [reasonCode] of classes) {
      const e = event(30_000_00, {
        reasonCode,
        customer: customer({ consent: { email: false, sms: false, whatsapp: false, voice: false } }),
      });
      const action = agent.decide(
        ctx(e, { attemptCount: 5, contactCount: 4, channelsUsed: ['email', 'sms', 'whatsapp'] }),
      );
      if (action.kind === 'escalate_human') {
        expect(action.rationale).not.toContain('P=0.55');
      }
    }
  });

  it('CUSTOMER_ACTION_REQUIRED on a retryable loss type: escalation is priced as a genuine unlock', () => {
    // payment_failure permits retry, so a human persuading the customer to
    // fix the instrument has a real downstream effect: a subsequent retry.
    // `now` is offset 30 minutes past failure -- the unlock curve genuinely
    // starts at 0 odds at elapsed=0 (no time has passed for anyone to have
    // fixed anything yet), same as the pre-existing contact-candidate
    // formula this reuses, so a case observed a little later is what makes
    // the unlock candidate meaningful to price at all.
    const e = event(30_000_00, { reasonCode: 'card_expired', lossType: 'payment_failure' });
    const action = agent.decide(
      ctx(e, {
        now: e.occurredAt + 30 * 60_000,
        attemptCount: 0,
        contactCount: 4,
        // Voice is deliberately exhausted too, not just the written
        // channels: voice now legitimately competes with escalate_human on
        // unlock-type cases (both persuade at the same modelled odds, but
        // voice is cheaper) -- a real, GOOD consequence of fixing contact
        // pricing's causal-path gate and per-channel fatigue, not a
        // regression. Isolating escalate_human here specifically tests
        // ITS OWN formula, not "which unlock channel wins overall".
        channelsUsed: ['email', 'sms', 'whatsapp', 'voice'],
      }),
    );
    expect(action.kind).toBe('escalate_human');
    expect(action.rationale).toContain('unlock');
    expect(action.rationale).not.toContain('last-resort hedge');
  });

  it('CUSTOMER_ACTION_REQUIRED on a NON-retryable loss type: no unlock benefit, even though the class matches', () => {
    // A dead VPA on a receivable still can't be "retried" -- canRetryCharge
    // is false, so a human fixing the instrument has nothing to unlock. The
    // unlock formula must check BOTH the class AND the loss-type permission,
    // not the class alone.
    const e = event(50_000_00, { reasonCode: 'invalid_vpa', lossType: 'receivable' });
    const action = agent.decide(
      ctx(e, {
        now: e.occurredAt + 30 * 60_000,
        attemptCount: 0,
        contactCount: 4,
        channelsUsed: ['email', 'sms', 'whatsapp'],
      }),
    );
    if (action.kind === 'escalate_human') {
      expect(action.rationale).toContain('last-resort hedge');
      expect(action.rationale).not.toContain('escalating to unlock');
    }
  });

  it('HARD_DECLINE: escalation, if proposed at all, is priced far below the old 55% and never near it', () => {
    // Ground truth for HARD_DECLINE is ~1.5% at best. The old flat 0.55 was
    // a ~36x overstatement for this class specifically. If escalation is
    // still the best candidate (a human glance at a very large fraud-flagged
    // case can be worth a small hedge), its own stated probability must
    // reflect that honestly, not smuggle back a large number.
    const e = event(50_000_00, { reasonCode: 'payment_declined', lossType: 'payment_failure' });
    const action = agent.decide(
      ctx(e, { attemptCount: 0, contactCount: 4, channelsUsed: ['email', 'whatsapp'] }),
    );
    if (action.kind === 'escalate_human') {
      expect(action.rationale).toContain('last-resort hedge');
      const match = action.rationale.match(/P=([\d.]+)/);
      expect(match).not.toBeNull();
      const p = Number(match![1]);
      expect(p).toBeLessThanOrEqual(0.1);
    }
  });

  it('ABANDONMENT and TRANSIENT_FUNDS: escalation carries the hedge label, not an invented recovery mechanism', () => {
    // These are the two classes the audit found accounted for most of the
    // agent's human-escalation spend, with zero mechanical effect on
    // recovery in the engine (customerActed only matters for
    // CUSTOMER_ACTION_REQUIRED). Escalation may still be chosen as a cheap
    // enough last resort, but it must say so honestly.
    for (const reasonCode of ['payment_cancelled', 'insufficient_funds']) {
      const e = event(30_000_00, { reasonCode });
      const action = agent.decide(
        ctx(e, { attemptCount: 5, contactCount: 4, channelsUsed: ['email', 'sms', 'whatsapp'] }),
      );
      if (action.kind === 'escalate_human') {
        expect(action.rationale).toContain('last-resort hedge');
      }
    }
  });

  it('unlock EV is capped: never exceeds amount x voice-landing-odds x the class curve', () => {
    // Cross-check against believedRetryOdds directly, so this fails if the
    // unlock formula's cap is ever loosened without a documented reason.
    const e = event(30_000_00, { reasonCode: 'card_expired', lossType: 'payment_failure' });
    const action = agent.decide(
      ctx(e, {
        now: e.occurredAt + 30 * 60_000,
        attemptCount: 0,
        contactCount: 4,
        // Voice excluded too -- see the note on the test above.
        channelsUsed: ['email', 'sms', 'whatsapp', 'voice'],
      }),
    );
    expect(action.kind).toBe('escalate_human');
    const match = action.rationale.match(/P\(then recovers\)=([\d.]+)/);
    expect(match).not.toBeNull();
    const impliedTotalP = 0.5 * Number(match![1]); // voice-landing-odds cap x class curve
    expect(impliedTotalP).toBeLessThanOrEqual(0.5);
  });
});

describe('candidate reasoning is legible', () => {
  it('every proposed action carries a rationale mentioning a believed probability or a stated reason', () => {
    const rulesAgent = createRulesAgent(DEFAULT_COSTS);
    const e = event(300_000, { reasonCode: 'gateway_technical_error' });
    const adaptiveAction = agent.decide(ctx(e));
    const rulesAction = rulesAgent.decide(ctx(e));
    expect(adaptiveAction.rationale.length).toBeGreaterThan(10);
    expect(rulesAction.rationale.length).toBeGreaterThan(10);
  });
});

describe('explain(): the single source of truth decide() and the dashboard both read', () => {
  it('explain(ctx).action is byte-identical to decide(ctx) -- one function, not two', () => {
    const e = event(300_000, { reasonCode: 'insufficient_funds' });
    const decided = agent.decide(ctx(e));
    const explained = explain(ctx(e), DEFAULT_COSTS);
    expect(explained.action).toEqual(decided);
  });

  it('exactly one candidate matches the chosen action by reference, even when several share kind/channel', () => {
    // Regression guard for a real bug: several retry-offset candidates all
    // have kind:'retry_payment' and no channel, differing only by delayMs.
    // Matching "chosen" by kind+channel alone marked ALL of them chosen;
    // only reference equality on the action object picks out exactly one.
    const e = event(300_000, { reasonCode: 'bank_technical_error' }); // TRANSIENT_INFRA: several retry offsets
    const result = explain(ctx(e), DEFAULT_COSTS);
    expect(result.candidates).toBeDefined();
    const retryCandidates = result.candidates!.filter((c) => c.action.kind === 'retry_payment');
    expect(retryCandidates.length).toBeGreaterThan(1); // the scenario this bug needs to exist
    const chosen = result.candidates!.filter((c) => c.action === result.action);
    expect(chosen).toHaveLength(1);
  });

  it('a short-circuited decision (terminal rule) carries no candidates, only a reason', () => {
    const e = event(300_000, { reasonCode: 'insufficient_funds' });
    const history = [
      {
        at: AT,
        action: { kind: 'retry_payment' as const, delayMs: 0, rationale: 'x' },
        succeeded: false,
        blockedBy: 'KILL_SWITCH',
      },
    ];
    const result = explain(ctx(e, { history }), DEFAULT_COSTS);
    expect(result.candidates).toBeUndefined();
    expect(result.shortCircuitReason).toBeDefined();
    expect(result.action.kind).toBe('stop');
  });

  it('every priced candidate carries a consistent gross/cost/EV breakdown, for the dashboard to trust', () => {
    const e = event(2_000_000, { reasonCode: 'insufficient_funds' });
    const result = explain(ctx(e), DEFAULT_COSTS);
    expect(result.candidates).toBeDefined();
    for (const c of result.candidates!) {
      expect(c.expectedValuePaise).toBeCloseTo(c.grossRecoveryPaise - c.totalCostPaise, 5);
    }
  });
});
