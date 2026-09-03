import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE, type CustomerProfile, type LossEvent } from '../domain/types.js';
import { runCase, runCohort } from '../eval/engine.js';
import { score } from '../eval/metrics.js';
import { Ledger } from '../ledger/ledger.js';
import { BASELINE_STRATEGIES } from '../policies/baselines.js';
import type { CaseContext, Strategy } from '../policies/types.js';
import { generateCohort } from '../sim/generator.js';
import { Rng } from '../sim/rng.js';
import { DEFAULT_COSTS, SCENARIO_IDS, getScenario } from '../sim/scenario.js';
import { createRulesAgent } from '../policies/rules-agent.js';
import {
  DEFAULT_COMPLIANCE,
  evaluateCompliance,
  evaluateEscalationCompliance,
  nextPermittedContactTime,
  QUIET_HOURS,
} from './compliance.js';
import { DEFAULT_LIMITS } from './limits.js';
import { gate, DEFAULT_GUARDRAILS } from './index.js';

const IST = 330;

/** 2026-09-01 at a given IST wall-clock time. */
const ist = (hh: number, mm = 0): number =>
  Date.parse(
    `2026-09-01T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`,
  );

const customer = (over: Partial<CustomerProfile> = {}): CustomerProfile => ({
  id: 'cust_test',
  dndRegistered: false,
  consent: { email: true, sms: true, whatsapp: true, voice: true },
  utcOffsetMinutes: IST,
  respondsToNudge: true,
  ...over,
});

const lossEvent = (over: Partial<LossEvent> = {}): LossEvent => ({
  id: 'loss_test',
  lossType: 'payment_failure',
  merchantId: 'merch_001',
  customer: customer(),
  amountPaise: 100_000,
  method: 'card',
  reasonCode: 'bank_technical_error',
  occurredAt: ist(12),
  debitStatus: 'no_debit',
  ...over,
});

const localHour = (ts: number): number => new Date(ts + IST * MINUTE).getUTCHours();

describe('quiet hours', () => {
  it('permits contact during the day', () => {
    expect(nextPermittedContactTime(ist(14), IST)).toBe(ist(14));
  });

  it('defers a late-evening contact to 09:00 the next morning', () => {
    // The scenario that matters: an infra failure at 20:30, the policy wants to
    // message 60 minutes later at 21:30, which is inside quiet hours.
    const wanted = ist(21, 30);
    const permitted = nextPermittedContactTime(wanted, IST);

    expect(permitted).toBeGreaterThan(wanted);
    expect(localHour(permitted)).toBe(QUIET_HOURS.endHour);
    expect(permitted).toBe(ist(9) + DAY);
  });

  it('defers an early-morning contact to 09:00 the same day', () => {
    const permitted = nextPermittedContactTime(ist(3), IST);
    expect(permitted).toBe(ist(9));
    expect(localHour(permitted)).toBe(9);
  });

  it('treats 09:00 exactly as permitted and 21:00 exactly as quiet', () => {
    expect(nextPermittedContactTime(ist(9), IST)).toBe(ist(9));
    expect(nextPermittedContactTime(ist(21), IST)).toBeGreaterThan(ist(21));
  });

  it('defers rather than blocks, so the revenue is not lost', () => {
    const verdict = evaluateCompliance('sms', customer(), ist(22), []);
    expect(verdict.kind).toBe('defer');
  });
});

describe('permission rules', () => {
  it('blocks telecom channels for a DND-registered customer', () => {
    for (const channel of ['sms', 'voice'] as const) {
      const verdict = evaluateCompliance(channel, customer({ dndRegistered: true }), ist(14), []);
      expect(verdict.kind).toBe('block');
      if (verdict.kind === 'block') expect(verdict.rule).toBe('DND_REGISTERED');
    }
  });

  it('still allows consent-based channels for a DND-registered customer', () => {
    // DND is a telecom rule. Email and WhatsApp are governed by consent, so
    // blanket-blocking them would forfeit revenue the customer opted in to.
    for (const channel of ['email', 'whatsapp'] as const) {
      expect(evaluateCompliance(channel, customer({ dndRegistered: true }), ist(14), []).kind).toBe(
        'allow',
      );
    }
  });

  it('blocks a channel the customer has not consented to', () => {
    const c = customer({ consent: { email: true, sms: false, whatsapp: false, voice: false } });
    expect(evaluateCompliance('sms', c, ist(14), []).kind).toBe('block');
    expect(evaluateCompliance('email', c, ist(14), []).kind).toBe('allow');
  });

  it('blocks, not defers, for permission failures: waiting cannot help', () => {
    const verdict = evaluateCompliance('sms', customer({ dndRegistered: true }), ist(3), []);
    // Inside quiet hours AND on DND. The permanent rule must win, otherwise the
    // agent would queue a contact it may never legally make.
    expect(verdict.kind).toBe('block');
  });
});

/**
 * `escalate_human` closes the compliance gap found in the final submission
 * audit: it is priced (`action-registry.ts:escalateSpec`) and simulated
 * (`eval/engine.ts`) as a real customer touch -- a person calling the
 * customer, at the same annoyance tier as a voice contact -- but `gate()`
 * used to wave it straight through with no consent, DND, or quiet-hours
 * check at all. `evaluateEscalationCompliance` closes that gap by applying
 * the same permission/timing rules a `voice` contact would face, without
 * double-governing the separate `MAX_HUMAN_ESCALATIONS` volume cap.
 */
describe('escalate_human is not exempt from consent, DND, or quiet hours', () => {
  it('blocks escalation for a customer who has not consented to voice contact', () => {
    const verdict = evaluateEscalationCompliance(
      customer({ consent: { email: true, sms: true, whatsapp: true, voice: false } }),
      ist(14),
    );
    expect(verdict.kind).toBe('block');
    if (verdict.kind === 'block') expect(verdict.rule).toBe('NO_CONSENT');
  });

  it('blocks escalation for a DND-registered customer, same as an automated voice call', () => {
    const verdict = evaluateEscalationCompliance(customer({ dndRegistered: true }), ist(14));
    expect(verdict.kind).toBe('block');
    if (verdict.kind === 'block') expect(verdict.rule).toBe('DND_REGISTERED');
  });

  it('defers, does not block, an escalation that would land inside quiet hours', () => {
    const verdict = evaluateEscalationCompliance(customer(), ist(22));
    expect(verdict.kind).toBe('defer');
    if (verdict.kind === 'defer') {
      expect(verdict.rule).toBe('QUIET_HOURS');
      expect(localHour(verdict.notBefore)).toBe(QUIET_HOURS.endHour);
    }
  });

  it('allows a consented, non-DND escalation inside permitted hours', () => {
    expect(evaluateEscalationCompliance(customer(), ist(14)).kind).toBe('allow');
  });

  it('a permission failure blocks even if it would also be inside quiet hours -- waiting cannot fix consent', () => {
    const verdict = evaluateEscalationCompliance(customer({ dndRegistered: true }), ist(3));
    expect(verdict.kind).toBe('block');
  });

  it('gate() routes escalate_human through the SAME evaluation, not a bypass path', () => {
    const escalate = { kind: 'escalate_human' as const, delayMs: 0, rationale: 'test' };
    const blockedByConsent = gate(
      {
        action: escalate,
        customer: customer({ consent: { email: true, sms: true, whatsapp: true, voice: false } }),
        at: ist(14),
        caseOpenedAt: ist(14),
        history: [],
      },
      DEFAULT_GUARDRAILS,
    );
    expect(blockedByConsent.kind).toBe('block');

    const blockedByDnd = gate(
      {
        action: escalate,
        customer: customer({ dndRegistered: true }),
        at: ist(14),
        caseOpenedAt: ist(14),
        history: [],
      },
      DEFAULT_GUARDRAILS,
    );
    expect(blockedByDnd.kind).toBe('block');

    const deferredByQuietHours = gate(
      { action: escalate, customer: customer(), at: ist(22), caseOpenedAt: ist(14), history: [] },
      DEFAULT_GUARDRAILS,
    );
    expect(deferredByQuietHours.kind).toBe('defer');

    const allowed = gate(
      { action: escalate, customer: customer(), at: ist(14), caseOpenedAt: ist(14), history: [] },
      DEFAULT_GUARDRAILS,
    );
    expect(allowed.kind).toBe('allow');
  });

  it('the existing 1-per-case escalation limit still applies on top of the new compliance check', () => {
    const escalate = { kind: 'escalate_human' as const, delayMs: 0, rationale: 'test' };
    const priorEscalation = [
      { at: ist(10), action: escalate, succeeded: false },
    ];
    const verdict = gate(
      { action: escalate, customer: customer(), at: ist(14), caseOpenedAt: ist(10), history: priorEscalation },
      DEFAULT_GUARDRAILS,
    );
    expect(verdict.kind).toBe('block');
    if (verdict.kind === 'block') expect(verdict.rule).toBe('MAX_HUMAN_ESCALATIONS');
  });

  it('end to end: a policy that always escalates can never make a human call a DND-registered or non-consenting customer', () => {
    const alwaysEscalate: Strategy = {
      id: 'always-escalate',
      name: 'Always escalate',
      description: 'Adversarial: proposes escalate_human on every decision.',
      decide: () => ({ kind: 'escalate_human', delayMs: 0, rationale: 'escalate every time' }),
    };

    for (const c of [
      customer({ dndRegistered: true }),
      customer({ consent: { email: true, sms: true, whatsapp: true, voice: false } }),
    ]) {
      const ledger = new Ledger();
      const result = runCase(
        lossEvent({ customer: c, amountPaise: 500_000 }),
        alwaysEscalate,
        DEFAULT_COSTS,
        new Rng(7),
        ledger,
      );
      expect(result.humanEscalations).toBe(0);

      const executedEscalations = ledger
        .all()
        .filter((e) => e.outcome === 'executed' && e.actionKind === 'escalate_human');
      expect(executedEscalations).toHaveLength(0);

      const blocked = ledger.all().filter((e) => e.actionKind === 'escalate_human' && e.outcome === 'blocked');
      expect(blocked.length).toBeGreaterThan(0);
      expect(blocked.every((e) => e.rule === 'DND_REGISTERED' || e.rule === 'NO_CONSENT')).toBe(true);
    }
  });

  it('a consented, non-DND customer inside permitted hours CAN still be escalated -- the fix does not loosen or remove the action', () => {
    const alwaysEscalate: Strategy = {
      id: 'always-escalate',
      name: 'Always escalate',
      description: 'Proposes escalate_human on every decision.',
      decide: () => ({ kind: 'escalate_human', delayMs: 0, rationale: 'escalate every time' }),
    };
    const ledger = new Ledger();
    const result = runCase(
      lossEvent({ occurredAt: ist(14), amountPaise: 500_000 }),
      alwaysEscalate,
      DEFAULT_COSTS,
      new Rng(7),
      ledger,
    );
    expect(result.humanEscalations).toBe(1); // capped by MAX_HUMAN_ESCALATIONS, not by the new compliance check
  });
});

/**
 * A policy that actively tries to break every rule. The point of the guardrails
 * is that this cannot succeed, no matter how badly the policy behaves.
 */
const adversarial: Strategy = {
  id: 'adversarial',
  name: 'Adversarial',
  description: 'Deliberately attempts to breach every limit and compliance rule.',
  decide: (ctx: CaseContext) => {
    // Alternate between hammering retries and spamming voice calls, always at
    // 03:00 local, forever.
    if (ctx.history.length % 2 === 0) {
      return { kind: 'retry_payment', delayMs: 0, rationale: 'hammer' };
    }
    return { kind: 'contact_customer', channel: 'voice', delayMs: 0, rationale: 'spam' };
  },
};

describe('adversarial policy cannot breach the guardrails', () => {
  const run = () =>
    runCase(
      lossEvent({ occurredAt: ist(3) }),
      adversarial,
      DEFAULT_COSTS,
      new Rng(7),
      new Ledger(),
    );

  it('terminates rather than looping forever', () => {
    const result = run();
    expect(result.retries).toBeLessThan(100);
  });

  it('cannot exceed the retry cap', () => {
    expect(run().retries).toBeLessThanOrEqual(5);
  });

  it('cannot exceed the contact cap', () => {
    expect(run().contacts).toBeLessThanOrEqual(4);
  });

  it('is actually stopped by guardrails, not merely well-behaved', () => {
    // If nothing were blocked, the caps above would be meaningless.
    expect(run().blockedActions).toBeGreaterThan(0);
  });

  it('never executes a contact inside quiet hours', () => {
    const ledger = new Ledger();
    runCase(lossEvent({ occurredAt: ist(3) }), adversarial, DEFAULT_COSTS, new Rng(7), ledger);

    const contacts = ledger
      .all()
      .filter((e) => e.outcome === 'executed' && e.actionKind === 'contact_customer');

    for (const entry of contacts) {
      const hour = localHour(entry.at);
      expect(hour).toBeGreaterThanOrEqual(QUIET_HOURS.endHour);
      expect(hour).toBeLessThan(QUIET_HOURS.startHour);
    }
  });

  it('never contacts a DND-registered customer at all', () => {
    const ledger = new Ledger();
    runCase(
      lossEvent({ customer: customer({ dndRegistered: true }) }),
      adversarial,
      DEFAULT_COSTS,
      new Rng(7),
      ledger,
    );

    const executedContacts = ledger
      .all()
      .filter((e) => e.outcome === 'executed' && e.actionKind === 'contact_customer');
    expect(executedContacts).toHaveLength(0);
  });

  it('still permits silent retries for a DND customer', () => {
    // DND restricts outreach, not payment retries. Blocking both would throw
    // away recoverable revenue for no compliance benefit.
    const result = runCase(
      lossEvent({ customer: customer({ dndRegistered: true }) }),
      adversarial,
      DEFAULT_COSTS,
      new Rng(7),
      new Ledger(),
    );
    expect(result.retries).toBeGreaterThan(0);
  });
});

describe('ledger', () => {
  it('records blocked actions as evidence, not silence', () => {
    const ledger = new Ledger();
    runCase(
      lossEvent({ customer: customer({ dndRegistered: true }) }),
      adversarial,
      DEFAULT_COSTS,
      new Rng(7),
      ledger,
    );
    const blocked = ledger.blocked();
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((e) => e.rule !== undefined && e.explanation !== undefined)).toBe(true);
  });

  it('uses simulation time, never wall-clock time', () => {
    const ledger = new Ledger();
    const event = lossEvent();
    runCase(event, adversarial, DEFAULT_COSTS, new Rng(7), ledger);

    for (const entry of ledger.all()) {
      expect(entry.at).toBeGreaterThanOrEqual(event.occurredAt);
      // Anything stamped with the real clock would land far in the future.
      expect(entry.at).toBeLessThan(event.occurredAt + 30 * DAY);
    }
  });

  it('is append-only: entries are frozen and sequential', () => {
    const ledger = new Ledger();
    runCase(lossEvent(), adversarial, DEFAULT_COSTS, new Rng(7), ledger);
    const all = ledger.all();
    expect(all.every((e, i) => e.seq === i)).toBe(true);
    expect(Object.isFrozen(all[0])).toBe(true);
  });

  it('does not leak state between runs', () => {
    const a = new Ledger();
    const b = new Ledger();
    runCase(lossEvent(), adversarial, DEFAULT_COSTS, new Rng(7), a);
    expect(b.size).toBe(0);
  });
});

describe('every strategy on every scenario', () => {
  const start = ist(0);

  for (const scenarioId of SCENARIO_IDS) {
    const scenario = { ...getScenario(scenarioId), cohortSize: 120 };
    const events = generateCohort(scenario, start);

    for (const strategy of [...BASELINE_STRATEGIES, adversarial]) {
      it(`${scenarioId} / ${strategy.id}: zero compliance violations`, () => {
        const metrics = score(runCohort(events, strategy, DEFAULT_COSTS, scenario.seed + 1));
        expect(metrics.complianceViolations).toBe(0);
      });
    }
  }
});

describe('determinism', () => {
  it('produces identical results from an identical seed', () => {
    const scenario = getScenario('baseline-week');
    const events = generateCohort(scenario, ist(0));
    const a = score(runCohort(events, BASELINE_STRATEGIES[2]!, DEFAULT_COSTS, 99));
    const b = score(runCohort(events, BASELINE_STRATEGIES[2]!, DEFAULT_COSTS, 99));

    expect(a.recoveredPaise).toBe(b.recoveredPaise);
    expect(a.costPaise).toBe(b.costPaise);
    expect(a.spamPoints).toBe(b.spamPoints);
  });

  it('regenerates an identical cohort from an identical scenario', () => {
    const scenario = getScenario('bank-outage');
    const a = generateCohort(scenario, ist(0));
    const b = generateCohort(scenario, ist(0));
    expect(a.map((e) => e.id + e.reasonCode + e.amountPaise)).toEqual(
      b.map((e) => e.id + e.reasonCode + e.amountPaise),
    );
  });
});

describe('cost model sanity', () => {
  it('prices voice far above messaging, reflecting goodwill cost', () => {
    expect(DEFAULT_COSTS.contactCostPaise.voice).toBeGreaterThan(
      DEFAULT_COSTS.contactCostPaise.whatsapp * 10,
    );
  });

  it('keeps all money as integer paise', () => {
    const values = [
      DEFAULT_COSTS.retryCostPaise,
      DEFAULT_COSTS.humanReviewCostPaise,
      ...Object.values(DEFAULT_COSTS.contactCostPaise),
    ];
    for (const v of values) expect(Number.isInteger(v)).toBe(true);
  });
});

describe('time helpers', () => {
  it('agrees on hour boundaries', () => {
    expect(localHour(ist(0))).toBe(0);
    expect(localHour(ist(23))).toBe(23);
    expect(ist(1) - ist(0)).toBe(HOUR);
  });
});

/**
 * The kill switch and the terminal rules.
 *
 * Both are advertised in the README as safety properties and neither had a test.
 * A safety feature nobody exercises is a claim, not a control.
 */
describe('kill switch', () => {
  const halted = {
    compliance: DEFAULT_COMPLIANCE,
    limits: { ...DEFAULT_LIMITS, killSwitch: true },
  };

  it('refuses every action kind', () => {
    for (const strategy of [...BASELINE_STRATEGIES, adversarial]) {
      const result = runCase(
        lossEvent(),
        strategy,
        DEFAULT_COSTS,
        new Rng(4),
        new Ledger(),
        halted,
      );
      expect(result.retries).toBe(0);
      expect(result.contacts).toBe(0);
      expect(result.humanEscalations).toBe(0);
    }
  });

  it('halts an entire cohort: nothing recovered, nothing spent', () => {
    const scenario = { ...getScenario('baseline-week'), cohortSize: 80 };
    const events = generateCohort(scenario, ist(0));
    const metrics = score(
      runCohort(events, adversarial, DEFAULT_COSTS, scenario.seed + 1, halted),
    );
    expect(metrics.recoveredPaise).toBe(0);
    expect(metrics.costPaise).toBe(0);
    expect(metrics.spamPoints).toBe(0);
  });

  it('records every refusal in the ledger rather than failing silently', () => {
    const ledger = new Ledger();
    runCase(lossEvent(), adversarial, DEFAULT_COSTS, new Rng(4), ledger, halted);
    const blocked = ledger.blocked();
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((e) => e.rule === 'KILL_SWITCH')).toBe(true);
  });
});

describe('terminal rules close a case', () => {
  it('the agent stops instead of re-proposing a permanently refused action', () => {
    // Regression: the agent once re-proposed the same retry 29 times against
    // CASE_AGE_LIMIT -- the exact loop it criticises fixed dunning for. A rule
    // that can never be satisfied must end the case, not be retried.
    const agent = createRulesAgent(DEFAULT_COSTS);
    const ledger = new Ledger();
    runCase(
      lossEvent({ lossType: 'subscription_mandate', reasonCode: 'insufficient_funds' }),
      agent,
      DEFAULT_COSTS,
      new Rng(4),
      ledger,
      { compliance: DEFAULT_COMPLIANCE, limits: { ...DEFAULT_LIMITS, maxCaseAgeMs: 2 * HOUR } },
    );

    const ageBlocks = ledger.all().filter((e) => e.rule === 'CASE_AGE_LIMIT');
    // One refusal is informative. A wall of identical refusals is a bug.
    expect(ageBlocks.length).toBeLessThanOrEqual(2);
  });
});
