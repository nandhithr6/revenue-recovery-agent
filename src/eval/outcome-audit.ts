import { HOUR, type CustomerSignal, type LossEvent } from '../domain/types.js';
import type { RecoveryClass } from '../domain/failure-taxonomy.js';
import { explain } from '../policies/adaptive-agent.js';
import { SPAM_POINT_PRICE_PAISE } from '../policies/playbook.js';
import type { CaseContext, Strategy } from '../policies/types.js';
import { NUDGE_EFFECTIVENESS, recoversViaLink, recoveryOdds } from '../sim/recovery-model.js';
import { Rng } from '../sim/rng.js';
import type { CostModel } from '../sim/scenario.js';
import { runCase, type CaseResult } from './engine.js';
import { Ledger } from '../ledger/ledger.js';
import { TraceSink, type CandidateSummary, type TraceStep } from './trace.js';

/**
 * Reads "recovery rate" as a denominator question, not a scoreboard.
 *
 * A recovered/total percentage invites "the rest is failure" -- but most of
 * a cohort's non-recovered cases are money that was never realistically
 * getable (HARD_DECLINE, a customer who never fixed their card), money the
 * agent correctly declined to keep chasing once the real odds went to zero,
 * or a real, well-timed attempt that simply lost its coin flip. This module
 * classifies every non-recovered case into one of eight buckets so the
 * dashboard can show that breakdown instead of a single percentage, and so a
 * genuine "agent picked worse than it should have" case (bucket 7) is
 * surfaced with its own case ID and the alternative action, rather than
 * blended into the other 199.
 *
 * Read-only: this never changes a decision, a candidate price, or a
 * guardrail. It re-simulates the SAME cohort with tracing switched on
 * (`explain()`'s own candidate list, the one `decide()` is built on -- see
 * `adaptive-agent.ts`) purely to look at what already happened, then
 * recomputes ground-truth probabilities from `sim/recovery-model.ts` --
 * exactly the numbers `eval/engine.ts` itself rolled against -- to judge
 * whether a rejected candidate's real expected value (not the agent's
 * believed one) was actually left on the table.
 */

export type OutcomeCategory =
  | 'genuinely_unrecoverable'
  | 'customer_never_acted'
  | 'hard_permanent_failure'
  | 'uncertain_verification_unsafe'
  | 'correctly_stopped_non_positive_ev'
  | 'correctly_waited_bad_luck'
  | 'wrong_action_missed_opportunity'
  | 'simulator_model_limitation';

export const OUTCOME_CATEGORY_LABEL: Readonly<Record<OutcomeCategory, string>> = {
  genuinely_unrecoverable: 'Genuinely unrecoverable at decision time',
  customer_never_acted: 'Customer never completed the required action',
  hard_permanent_failure: 'Hard/permanent failure (issuer refused with prejudice)',
  uncertain_verification_unsafe: 'Uncertain / verification case, retry would be unsafe',
  correctly_stopped_non_positive_ev: 'Correctly stopped -- real expected value was non-positive',
  correctly_waited_bad_luck: 'Correctly attempted -- the real odds simply did not land',
  wrong_action_missed_opportunity: 'Agent picked worse than it should have -- real opportunity missed',
  simulator_model_limitation: 'Simulator/taxonomy limitation, not a policy decision',
};

export interface NonRecoveredCase {
  readonly eventId: string;
  readonly amountPaise: number;
  readonly recoveryClass: RecoveryClass | 'UNKNOWN';
  readonly stoppedReason: string;
  readonly category: OutcomeCategory;
  readonly note: string;
  readonly missedAction?: string;
  readonly missedRealEvPaise?: number;
}

export interface OutcomeCategorySummary {
  readonly category: OutcomeCategory;
  readonly label: string;
  readonly count: number;
  readonly atRiskPaise: number;
  readonly byClass: Readonly<Record<string, number>>;
  readonly examples: readonly NonRecoveredCase[];
}

export interface OutcomeAudit {
  readonly totalCases: number;
  readonly recoveredCases: number;
  readonly recoveryRate: number;
  readonly nonRecoveredCases: number;
  readonly nonRecoveredAtRiskPaise: number;
  readonly categories: readonly OutcomeCategorySummary[];
}

/** > Rs 50 of real, ground-truth positive EV rejected at the final decision. */
const MISSED_OPPORTUNITY_THRESHOLD_PAISE = 5_000;
/** A real success probability above this is "a genuine shot", not noise. */
const REAL_CHANCE_THRESHOLD = 0.05;

/** P(a voice call draws a POSITIVE signal) per class -- summed directly from
 *  `sim/voice-signal-model.ts`'s own DISTRIBUTION table (promise_to_pay,
 *  funds_available_now, instrument_fixed are the positive kinds; see
 *  `isPositiveSignal` in `eval/engine.ts`). Duplicated here, read-only, only
 *  for this audit's real-EV recomputation -- the simulator deliberately
 *  exposes a draw, not a probability table, so policy code can never read it
 *  as one at runtime; this module is not policy code and never feeds a
 *  decision. */
const POSITIVE_SIGNAL_PROB: Partial<Record<RecoveryClass, number>> = {
  TRANSIENT_FUNDS: 0.5,
  CUSTOMER_ACTION_REQUIRED: 0.4,
  ABANDONMENT: 0.3,
  TRANSIENT_INFRA: 0,
  AUTH_FAILURE: 0.3,
  HARD_DECLINE: 0,
};

function candidateHook(ctx: CaseContext, costs: CostModel): readonly CandidateSummary[] | undefined {
  const result = explain(ctx, costs, SPAM_POINT_PRICE_PAISE);
  if (!result.candidates) return undefined;
  return result.candidates.map((c) => ({
    kind: c.action.kind,
    ...(c.action.channel ? { channel: c.action.channel } : {}),
    grossRecoveryPaise: c.grossRecoveryPaise,
    costPaise: c.costPaise,
    spamPoints: c.spamPoints,
    expectedValuePaise: c.expectedValuePaise,
    ...(c.dominated ? { dominated: true } : {}),
    chosen: c.action === result.action,
  }));
}

function customerEngaged(history: readonly { action: { kind: string }; succeeded?: boolean }[]): boolean {
  return history.some(
    (h) => (h.action.kind === 'contact_customer' || h.action.kind === 'escalate_human') && h.succeeded === true,
  );
}

function lastSignal(history: readonly { signal?: CustomerSignal }[]): CustomerSignal | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i]!.signal;
    if (s) return s;
  }
  return undefined;
}

function classifyOne(
  event: LossEvent,
  result: CaseResult,
  trace: readonly TraceStep[],
): NonRecoveredCase {
  const { recoveryClass, stoppedReason, history } = result;
  const engaged = customerEngaged(history);
  const signal = lastSignal(history);
  const anyRetries = result.retries > 0;
  const anyContacts = result.contacts > 0;

  // ---- 4: dispute / refusal signal, or an unresolved duplicate-debit hold ----
  if (signal && (signal.kind === 'disputes_charge' || signal.kind === 'refused')) {
    return {
      eventId: event.id,
      amountPaise: event.amountPaise,
      recoveryClass,
      stoppedReason,
      category: 'uncertain_verification_unsafe',
      note: `Voice signal "${signal.kind}" -- continued contact would be unsafe or inappropriate; the agent stopped correctly.`,
    };
  }
  if (event.debitStatus === 'uncertain' && result.retries === 0 && stoppedReason.includes('horizon')) {
    return {
      eventId: event.id,
      amountPaise: event.amountPaise,
      recoveryClass,
      stoppedReason,
      category: 'uncertain_verification_unsafe',
      note: 'debitStatus is "uncertain" (the original authorisation outcome was never confirmed); the case aged out before the duplicate-debit verification hold cleared.',
    };
  }

  // ---- 3: HARD_DECLINE -- issuer refused with prejudice ----
  if (recoveryClass === 'HARD_DECLINE') {
    return {
      eventId: event.id,
      amountPaise: event.amountPaise,
      recoveryClass,
      stoppedReason,
      category: 'hard_permanent_failure',
      note: 'HARD_DECLINE: ground-truth retry odds are flat at 1.5% forever and no channel has a causal recovery path for this class. Correctly not pursued.',
    };
  }

  // ---- 8: no recovery class could be assigned at all ----
  if (recoveryClass === 'UNKNOWN') {
    return {
      eventId: event.id,
      amountPaise: event.amountPaise,
      recoveryClass,
      stoppedReason,
      category: 'simulator_model_limitation',
      note: 'No recovery class could be assigned (reason code absent or undocumented, and not an abandonment) -- a taxonomy/labelling gap in the case data, not a policy decision.',
    };
  }

  // ---- 1/2: CUSTOMER_ACTION_REQUIRED ----
  if (recoveryClass === 'CUSTOMER_ACTION_REQUIRED') {
    if (anyContacts && !engaged) {
      return {
        eventId: event.id,
        amountPaise: event.amountPaise,
        recoveryClass,
        stoppedReason,
        category: 'customer_never_acted',
        note: `Instrument required a customer fix; ${result.contacts} contact attempt(s) made, none landed or acted on. Retry has no independent path for this class.`,
      };
    }
    if (!anyContacts) {
      return {
        eventId: event.id,
        amountPaise: event.amountPaise,
        recoveryClass,
        stoppedReason,
        category: 'genuinely_unrecoverable',
        note: 'CUSTOMER_ACTION_REQUIRED with no consented contact channel available at any point -- no path to a customer fix existed to try.',
      };
    }
    // else: contact landed (engaged) but the case still didn't recover --
    // falls through to the general real-odds analysis below.
  }

  // ---- General case: was a real (ground-truth) opportunity missed, was a
  // real chance simply unlucky, or was there never a real chance at all? ----
  const lastPriced = [...trace].reverse().find((t) => t.candidates && t.candidates.length > 0);
  let bestMissed: { c: CandidateSummary; realEv: number } | undefined;

  if (lastPriced) {
    const rejects = (lastPriced.candidates ?? []).filter((c) => !c.chosen && c.kind !== 'stop');
    for (const c of rejects) {
      const elapsedAtStep = lastPriced.at - event.occurredAt;
      let realGross = 0;
      if (c.kind === 'retry_payment') {
        const odds = recoveryOdds(recoveryClass, elapsedAtStep, result.retries, engaged);
        realGross = event.amountPaise * odds.probability;
      } else if (c.kind === 'contact_customer' && c.channel) {
        const landP = event.customer.respondsToNudge ? (NUDGE_EFFECTIVENESS[c.channel] ?? 0) : 0;
        realGross = recoversViaLink(event.lossType)
          ? event.amountPaise * landP * recoveryOdds(recoveryClass, elapsedAtStep, result.retries, true).probability
          : 0;
      }
      const realEv = realGross - c.costPaise - c.spamPoints * SPAM_POINT_PRICE_PAISE;
      if (realEv > 0 && (!bestMissed || realEv > bestMissed.realEv)) bestMissed = { c, realEv };
    }
  }

  if (bestMissed && bestMissed.realEv > MISSED_OPPORTUNITY_THRESHOLD_PAISE) {
    return {
      eventId: event.id,
      amountPaise: event.amountPaise,
      recoveryClass,
      stoppedReason,
      category: 'wrong_action_missed_opportunity',
      note: `At the last decision, ground truth gives a rejected candidate (${bestMissed.c.kind}${bestMissed.c.channel ? '/' + bestMissed.c.channel : ''}) a real positive EV of ~₹${(bestMissed.realEv / 100).toFixed(0)} that the agent's own believed pricing missed.`,
      missedAction: `${bestMissed.c.kind}${bestMissed.c.channel ? ' via ' + bestMissed.c.channel : ''}`,
      missedRealEvPaise: bestMissed.realEv,
    };
  }

  // 5 vs 6: did any EXECUTED attempt carry real, non-trivial ground-truth
  // probability of success? Its failure is bad luck (6) regardless of how
  // the case ended. If every executed attempt's real probability was
  // negligible -- or nothing was ever attempted -- stopping was the
  // economically correct read of the real odds, not just the believed ones
  // (5).
  let retriesSoFar = 0;
  let contactActed = false;
  let maxRealP = 0;
  let maxRealPAction = '';

  for (const h of history) {
    if (h.action.kind === 'retry_payment') {
      if (!recoversViaLink(event.lossType)) {
        const p = recoveryOdds(recoveryClass, h.at - event.occurredAt, retriesSoFar, contactActed).probability;
        if (p > maxRealP) {
          maxRealP = p;
          maxRealPAction = `retry_payment @+${((h.at - event.occurredAt) / HOUR).toFixed(1)}h`;
        }
      }
      retriesSoFar += 1;
    } else if (h.action.kind === 'contact_customer' && h.action.channel) {
      if (h.action.channel === 'voice') {
        const p = POSITIVE_SIGNAL_PROB[recoveryClass] ?? 0;
        if (p > maxRealP) {
          maxRealP = p;
          maxRealPAction = 'contact_customer via voice';
        }
      } else if (recoversViaLink(event.lossType)) {
        const landP = event.customer.respondsToNudge ? (NUDGE_EFFECTIVENESS[h.action.channel] ?? 0) : 0;
        const p = landP * recoveryOdds(recoveryClass, h.at - event.occurredAt, retriesSoFar, true).probability;
        if (p > maxRealP) {
          maxRealP = p;
          maxRealPAction = `contact_customer via ${h.action.channel}`;
        }
      }
      if (h.succeeded) contactActed = true;
    } else if (h.action.kind === 'escalate_human' && h.succeeded) {
      contactActed = true;
    }
  }

  if (maxRealP > REAL_CHANCE_THRESHOLD) {
    return {
      eventId: event.id,
      amountPaise: event.amountPaise,
      recoveryClass,
      stoppedReason,
      category: 'correctly_waited_bad_luck',
      note: `Best executed attempt (${maxRealPAction}) carried a real ground-truth success probability of ${(maxRealP * 100).toFixed(0)}% and simply did not land. Stopped reason: "${stoppedReason}".`,
    };
  }

  if (anyRetries || anyContacts) {
    return {
      eventId: event.id,
      amountPaise: event.amountPaise,
      recoveryClass,
      stoppedReason,
      category: 'correctly_stopped_non_positive_ev',
      note: `Agent engaged the case (${result.retries} retr${result.retries === 1 ? 'y' : 'ies'}, ${result.contacts} contact(s)), but every executed attempt's real ground-truth success probability was negligible (best ${(maxRealP * 100).toFixed(1)}%) -- continuing would not have been justified by the actual odds either, not only the believed ones.`,
    };
  }

  return {
    eventId: event.id,
    amountPaise: event.amountPaise,
    recoveryClass,
    stoppedReason,
    category: 'correctly_stopped_non_positive_ev',
    note: `No retry or contact was ever attempted (stopped reason: "${stoppedReason}"); the fully priced candidate set never cleared cost against real ground-truth odds.`,
  };
}

const CATEGORY_ORDER: readonly OutcomeCategory[] = [
  'genuinely_unrecoverable',
  'customer_never_acted',
  'hard_permanent_failure',
  'uncertain_verification_unsafe',
  'correctly_stopped_non_positive_ev',
  'correctly_waited_bad_luck',
  'wrong_action_missed_opportunity',
  'simulator_model_limitation',
];

/**
 * Classify every non-recovered case in one cohort run. Re-simulates the
 * cohort with tracing on (separate RNG stream from any metrics-bearing run,
 * exactly like `runTracedCohort` in `run-all.ts` -- this never feeds
 * `strategies[].metrics`, only this breakdown).
 */
export function auditOutcomes(
  events: readonly LossEvent[],
  strategy: Strategy,
  costs: CostModel,
  seed: number,
  maxExamplesPerCategory = 5,
): OutcomeAudit {
  const rng = new Rng(seed);
  const ledger = new Ledger();

  const all: NonRecoveredCase[] = [];
  let recoveredCount = 0;

  for (const event of events) {
    const sink = new TraceSink();
    const result = runCase(event, strategy, costs, rng, ledger, undefined, sink, (ctx) => candidateHook(ctx, costs));
    if (result.recovered) {
      recoveredCount += 1;
      continue;
    }
    all.push(classifyOne(event, result, sink.drain()));
  }

  const byCategory = new Map<OutcomeCategory, NonRecoveredCase[]>();
  for (const c of all) {
    const arr = byCategory.get(c.category) ?? [];
    arr.push(c);
    byCategory.set(c.category, arr);
  }

  const categories: OutcomeCategorySummary[] = CATEGORY_ORDER.map((category) => {
    const cases = byCategory.get(category) ?? [];
    const byClass: Record<string, number> = {};
    for (const c of cases) byClass[c.recoveryClass] = (byClass[c.recoveryClass] ?? 0) + 1;
    return {
      category,
      label: OUTCOME_CATEGORY_LABEL[category],
      count: cases.length,
      atRiskPaise: cases.reduce((s, c) => s + c.amountPaise, 0),
      byClass,
      examples:
        category === 'wrong_action_missed_opportunity'
          ? cases // every one of these is worth naming; there are never many
          : cases.slice(0, maxExamplesPerCategory),
    };
  });

  return {
    totalCases: events.length,
    recoveredCases: recoveredCount,
    recoveryRate: events.length === 0 ? 0 : recoveredCount / events.length,
    nonRecoveredCases: all.length,
    nonRecoveredAtRiskPaise: all.reduce((s, c) => s + c.amountPaise, 0),
    categories,
  };
}
