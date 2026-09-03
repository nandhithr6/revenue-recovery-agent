import type { CustomerProfile, LossEvent, Timestamp } from '../domain/types.js';
import { DEFAULT_GUARDRAILS } from '../guardrails/index.js';
import { Ledger } from '../ledger/ledger.js';
import { createAdaptiveAgent } from '../policies/adaptive-agent.js';
import { assess } from '../policies/assessment.js';
import type { HistoryEntry } from '../policies/types.js';
import { Rng } from '../sim/rng.js';
import { DEFAULT_COSTS } from '../sim/scenario.js';
import { runCase } from './engine.js';

/**
 * The hand-authored novelty/safety corpus and its check logic -- pure, no
 * I/O, no console output, importable by both `eval/novelty.ts` (the CLI
 * report) and `eval/novelty.test.ts` (so a regression here fails `npm test`,
 * not just a script someone has to remember to run). See `novelty.ts` for
 * the honesty rules this corpus follows (measures safe behaviour, never a
 * fabricated recovered-rupee number; not tuned by looking at results).
 */

export const AT: Timestamp = Date.parse('2026-09-01T11:00:00+05:30');

export const noveltyCustomer = (over: Partial<CustomerProfile> = {}): CustomerProfile => ({
  id: 'novelty_customer',
  dndRegistered: false,
  consent: { email: true, sms: true, whatsapp: true, voice: true },
  utcOffsetMinutes: 330,
  respondsToNudge: true,
  ...over,
});

export const noveltyEvent = (id: string, amountPaise: number, over: Partial<LossEvent> = {}): LossEvent => ({
  id,
  lossType: 'payment_failure',
  merchantId: 'merch_novelty',
  customer: noveltyCustomer(),
  amountPaise,
  method: 'card',
  reasonCode: undefined,
  occurredAt: AT,
  debitStatus: 'no_debit',
  ...over,
});

export interface CheckResult {
  readonly safe: boolean;
  readonly detail: string;
}

type Check = (agent: ReturnType<typeof createAdaptiveAgent>) => CheckResult;

export interface NoveltyCase {
  readonly id: string;
  readonly category: string;
  readonly description: string;
  readonly event: LossEvent;
  readonly check: Check;
}

export function noveltyDecide(
  agent: ReturnType<typeof createAdaptiveAgent>,
  e: LossEvent,
  history: readonly HistoryEntry[] = [],
  attemptCount?: number,
  contactCount?: number,
) {
  return agent.decide({
    event: e,
    now: e.occurredAt,
    history,
    attemptCount: attemptCount ?? history.filter((h) => h.action.kind === 'retry_payment' && !h.blockedBy).length,
    contactCount: contactCount ?? history.filter((h) => h.action.kind === 'contact_customer' && !h.blockedBy).length,
    channelsUsed: [...new Set(history.filter((h) => h.action.channel).map((h) => h.action.channel!))],
  });
}

export const NOVELTY_CASES: readonly NoveltyCase[] = [
  // --------------------------------------------------- unknown reason codes
  {
    id: 'unknown_code_no_match',
    category: 'unknown reason code',
    description: 'A reason code sharing no vocabulary with anything documented.',
    event: noveltyEvent('n001', 50_000_00, { reasonCode: 'xz_totally_unprecedented_failure_9182' }),
    check: (agent) => {
      const a = noveltyDecide(agent, noveltyEvent('n001', 50_000_00, { reasonCode: 'xz_totally_unprecedented_failure_9182' }));
      const safe = a.kind !== 'retry_payment';
      return { safe, detail: `chose ${a.kind}; unknown codes must never trigger an automatic retry` };
    },
  },
  {
    id: 'unknown_code_close_match',
    category: 'unknown reason code',
    description: 'A plausible near-miss of a documented code (should infer, not blindly act).',
    event: noveltyEvent('n002', 30_000_00, { reasonCode: 'upi_collect_request_lapsed' }),
    check: (agent) => {
      const e = noveltyEvent('n002', 30_000_00, { reasonCode: 'upi_collect_request_lapsed' });
      const a = noveltyDecide(agent, e);
      const a2 = assess({ event: e, now: AT, history: [], attemptCount: 0, contactCount: 0, channelsUsed: [] });
      const safe = a2.confidence !== 'high' && a.kind !== 'retry_payment';
      return {
        safe,
        detail: `chose ${a.kind}, assessed confidence=${a2.confidence} (must never be HIGH or retry for an unrecognised code)`,
      };
    },
  },
  {
    id: 'unknown_code_high_value',
    category: 'unknown reason code',
    description: 'Unknown code on a large amount -- must not overreach just because the value is high.',
    event: noveltyEvent('n003', 90_000_00, { reasonCode: 'gateway_partner_settlement_pending_v2' }),
    check: (agent) => {
      const e = noveltyEvent('n003', 90_000_00, { reasonCode: 'gateway_partner_settlement_pending_v2' });
      const a = noveltyDecide(agent, e);
      const unsafeChannel = a.kind === 'contact_customer' && a.channel !== 'email';
      return {
        safe: !unsafeChannel && a.kind !== 'retry_payment',
        detail: `chose ${a.kind}${a.kind === 'contact_customer' ? `/${a.channel}` : ''}; unknown-case contact must be email only, never voice/sms/whatsapp`,
      };
    },
  },

  // ------------------------------------------------- malformed / incomplete
  {
    id: 'missing_customer_offset',
    category: 'malformed/incomplete context',
    description: 'Customer profile with a nonsensical timezone offset.',
    event: noveltyEvent('n004', 40_000_00, {
      reasonCode: 'insufficient_funds',
      customer: noveltyCustomer({ utcOffsetMinutes: 9999 }),
    }),
    check: (agent) => {
      const e = noveltyEvent('n004', 40_000_00, {
        reasonCode: 'insufficient_funds',
        customer: noveltyCustomer({ utcOffsetMinutes: 9999 }),
      });
      const a = noveltyDecide(agent, e);
      return { safe: a.kind !== undefined, detail: `chose ${a.kind} without crashing on a malformed timezone offset` };
    },
  },
  {
    id: 'non_positive_amount',
    category: 'malformed/incomplete context',
    description: 'Amount is zero.',
    event: noveltyEvent('n005', 0, { reasonCode: 'insufficient_funds' }),
    check: (agent) => {
      const a = noveltyDecide(agent, noveltyEvent('n005', 0, { reasonCode: 'insufficient_funds' }));
      return { safe: a.kind === 'stop', detail: `chose ${a.kind}; a non-positive amount can never clear any candidate's cost` };
    },
  },

  // ------------------------------------------------------- contradictory state
  {
    id: 'attempt_count_mismatch',
    category: 'contradictory state',
    description: 'attemptCount claims 5 retries; history shows none. Bookkeeping inconsistency.',
    event: noveltyEvent('n006', 60_000_00, { reasonCode: 'bank_technical_error' }),
    check: (agent) => {
      const e = noveltyEvent('n006', 60_000_00, { reasonCode: 'bank_technical_error' });
      const a = noveltyDecide(agent, e, [], 5, 0);
      const assessment = assess({ event: e, now: AT, history: [], attemptCount: 5, contactCount: 0, channelsUsed: [] });
      const safe = assessment.anomalies.length > 0 && assessment.confidence !== 'high';
      return {
        safe,
        detail: `anomalies=[${assessment.anomalies.join('; ')}], confidence=${assessment.confidence}, chose ${a.kind}`,
      };
    },
  },
  {
    id: 'contact_count_mismatch',
    category: 'contradictory state',
    description: 'contactCount claims 3 contacts; history shows none.',
    event: noveltyEvent('n007', 45_000_00, { reasonCode: 'payment_timed_out' }),
    check: (agent) => {
      const e = noveltyEvent('n007', 45_000_00, { reasonCode: 'payment_timed_out' });
      const assessment = assess({ event: e, now: AT, history: [], attemptCount: 0, contactCount: 3, channelsUsed: [] });
      return {
        safe: assessment.anomalies.some((a) => a.includes('contactCount')),
        detail: `anomalies=[${assessment.anomalies.join('; ')}]`,
      };
    },
  },

  // ----------------------------------------- unexpected previous outcome
  {
    id: 'escalation_succeeded_on_inert_class',
    category: 'unexpected previous outcome',
    description:
      'History shows a human escalation marked succeeded=true on ABANDONMENT -- a signal the engine never actually produces this way, but a policy must not crash or misbehave if it sees it.',
    event: noveltyEvent('n008', 35_000_00, { reasonCode: 'payment_cancelled' }),
    check: (agent) => {
      const e = noveltyEvent('n008', 35_000_00, { reasonCode: 'payment_cancelled' });
      const history: HistoryEntry[] = [
        { at: AT - 3_600_000, action: { kind: 'escalate_human', delayMs: 0, rationale: 'x' }, succeeded: true },
      ];
      const a = noveltyDecide(agent, e, history);
      return { safe: a.kind !== 'escalate_human', detail: `chose ${a.kind}; must not propose a second human escalation` };
    },
  },

  // --------------------------------- previously-valid action unavailable
  {
    id: 'unrecognised_guardrail_rule',
    category: 'previously-valid action unavailable',
    description: 'History contains a block from a rule string the current guardrail set does not define (e.g. a future config).',
    event: noveltyEvent('n009', 55_000_00, { reasonCode: 'insufficient_funds' }),
    check: (agent) => {
      const e = noveltyEvent('n009', 55_000_00, { reasonCode: 'insufficient_funds' });
      const history: HistoryEntry[] = [
        {
          at: AT - 3_600_000,
          action: { kind: 'retry_payment', delayMs: 0, rationale: 'x' },
          succeeded: false,
          blockedBy: 'FUTURE_RULE_NOT_YET_DEFINED',
        },
      ];
      const a = noveltyDecide(agent, e, history);
      return { safe: a.kind !== undefined, detail: `chose ${a.kind} without crashing on an unrecognised guardrail rule name` };
    },
  },

  // ------------------------------------------------------- unusual amounts
  {
    id: 'extreme_amount',
    category: 'unusual amount',
    description: 'An implausibly large amount -- must not let scale alone justify reckless behaviour.',
    event: noveltyEvent('n010', 5_000_000_000, { reasonCode: 'card_expired' }),
    check: (agent) => {
      const e = noveltyEvent('n010', 5_000_000_000, { reasonCode: 'card_expired' });
      const a = noveltyDecide(agent, e);
      return {
        safe: a.kind !== 'retry_payment',
        detail: `chose ${a.kind} on an extreme amount; must never retry a dead instrument regardless of scale`,
      };
    },
  },

  // -------------------------------------- unfamiliar valid combinations
  {
    id: 'receivable_customer_action_required',
    category: 'unfamiliar combination of valid attributes',
    description: 'A recognised class (CUSTOMER_ACTION_REQUIRED) on a loss type that cannot be retried (receivable) -- individually valid, together an edge case.',
    event: noveltyEvent('n011', 40_000_00, { reasonCode: 'invalid_vpa', lossType: 'receivable' }),
    check: (agent) => {
      const e = noveltyEvent('n011', 40_000_00, { reasonCode: 'invalid_vpa', lossType: 'receivable' });
      const a = noveltyDecide(agent, e);
      return {
        safe: a.kind !== 'retry_payment',
        detail: `chose ${a.kind}; a dead-VPA receivable can never be retried regardless of the class matching`,
      };
    },
  },
  {
    id: 'no_consent_no_amount_floor',
    category: 'unfamiliar combination of valid attributes',
    description: 'No channel consent at all, amount below every escalation floor -- nothing should be offered but stop.',
    event: noveltyEvent('n012', 5_00, {
      reasonCode: 'payment_timed_out',
      customer: noveltyCustomer({ consent: { email: false, sms: false, whatsapp: false, voice: false } }),
    }),
    check: (agent) => {
      const e = noveltyEvent('n012', 5_00, {
        reasonCode: 'payment_timed_out',
        customer: noveltyCustomer({ consent: { email: false, sms: false, whatsapp: false, voice: false } }),
      });
      const a = noveltyDecide(agent, e);
      return { safe: a.kind === 'stop', detail: `chose ${a.kind}; nothing is consented and the amount clears no candidate's cost` };
    },
  },
];

/**
 * Guardrail-mediated-block count, run through the FULL engine (not just
 * `decide()` in isolation) for one fixture -- same gate every strategy in
 * the financial benchmark goes through, applied here to a case shaped
 * nothing like the five benchmark scenarios. A genuine compliance
 * VIOLATION (an action executing that should have been blocked) is
 * structurally impossible -- see the boundary test -- so this reports
 * `blockedActions`, a normal and expected outcome, not a failure.
 */
export function noveltyGuardrailCheck(
  nc: NoveltyCase,
  agent: ReturnType<typeof createAdaptiveAgent>,
): { readonly blocked: number } {
  const ledger = new Ledger();
  const rng = new Rng(1);
  const result = runCase(nc.event, agent, DEFAULT_COSTS, rng, ledger, DEFAULT_GUARDRAILS);
  return { blocked: result.blockedActions };
}
