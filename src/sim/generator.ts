import {
  lookupReason,
  reasonsForMethod,
  type PaymentMethod,
} from '../domain/failure-taxonomy.js';
import {
  CHANNELS,
  type Channel,
  type CustomerProfile,
  type DebitStatus,
  type LossEvent,
  type LossType,
} from '../domain/types.js';
import { Rng } from './rng.js';
import type { Scenario } from './scenario.js';

/**
 * Turns a Scenario into a concrete cohort of loss events.
 *
 * Deterministic: the same scenario always produces the same cohort, so strategy
 * comparisons differ only by strategy.
 */

/** Indian metro offsets are all UTC+5:30; kept as a field for future locales. */
const IST_OFFSET_MINUTES = 330;

function buildCustomer(rng: Rng, scenario: Scenario, index: number): CustomerProfile {
  const consent = Object.fromEntries(
    CHANNELS.map((c) => [c, rng.chance(scenario.consentRates[c])]),
  ) as Record<Channel, boolean>;

  return {
    id: `cust_${index.toString().padStart(5, '0')}`,
    dndRegistered: rng.chance(scenario.dndRate),
    consent,
    utcOffsetMinutes: IST_OFFSET_MINUTES,
    respondsToNudge: rng.chance(scenario.nudgeResponseRate),
  };
}

/**
 * Draw a failure reason valid for the given method.
 *
 * The scenario's failureMix is global, but not every reason applies to every
 * method: a card cannot fail with `invalid_vpa`. We therefore restrict the mix
 * to method-valid reasons and renormalise, rather than redrawing until we get
 * lucky.
 */
function drawReasonCode(
  rng: Rng,
  scenario: Scenario,
  method: PaymentMethod,
): string {
  const valid = reasonsForMethod(method);
  const entries: [string, number][] = [];

  for (const reason of valid) {
    const weight = scenario.failureMix[reason.code];
    if (weight !== undefined && weight > 0) entries.push([reason.code, weight]);
  }

  if (entries.length === 0) {
    throw new Error(
      `Scenario "${scenario.id}" has no positive-weight failure reasons valid for method "${method}"`,
    );
  }
  return rng.weighted(entries);
}

/**
 * Checkout abandonment has no bank-side failure reason: nothing was declined,
 * the customer simply left. We model it with the abandonment reason codes.
 */
const ABANDONMENT_CODES: Readonly<Record<PaymentMethod, readonly string[]>> = {
  card: ['payment_cancelled', 'payment_timed_out'],
  upi: ['payment_cancelled', 'payment_timed_out', 'payment_collect_request_expired'],
};

/**
 * Whether this failure's `reason` code represents a DEFINITIVE decline
 * response, or a genuine timeout where no response was ever received --
 * see `DebitStatus`'s own doc comment in `domain/types.ts` for the full
 * reasoning. Deliberately not a per-reason-code lookup table: only
 * `payment_timed_out` means "no response," and only when there was a real
 * charge behind it to retry in the first place. A `checkout_abandonment`
 * timeout never reached authorisation, so it carries no duplicate-debit
 * risk regardless of sharing the same reason string.
 *
 * NOTE (said plainly, not left implicit): this simulator has no case in
 * `'debited'` state. Every loss type it models is a payment that never
 * captured -- a declined authorisation, an abandoned checkout, an
 * unattempted receivable. Recovering money that was already captured and
 * later reversed (a chargeback, a post-capture dispute) is a different
 * problem with a different mechanic (a dispute/settlement process, not a
 * retry-or-nudge one), and this codebase has never modelled it. Naming
 * that boundary explicitly is more honest than a `debited` branch that
 * would never actually be reached by anything the generator produces.
 */
function deriveDebitStatus(lossType: LossType, reasonCode: string): DebitStatus {
  const canRetryCharge = lossType === 'payment_failure' || lossType === 'subscription_mandate';
  if (!canRetryCharge) return 'no_debit';
  return reasonCode === 'payment_timed_out' ? 'uncertain' : 'no_debit';
}

export function generateCohort(scenario: Scenario, startAt: number): LossEvent[] {
  const rng = new Rng(scenario.seed);
  const events: LossEvent[] = [];

  const methodEntries = Object.entries(scenario.methodMix)
    .filter((e): e is [PaymentMethod, number] => e[1] !== undefined && e[1] > 0)
    .map(([m, w]) => [m, w] as const);

  const lossTypeEntries = Object.entries(scenario.lossTypeMix)
    .filter((e): e is [LossType, number] => e[1] !== undefined && e[1] > 0)
    .map(([t, w]) => [t, w] as const);

  for (let i = 0; i < scenario.cohortSize; i++) {
    const method = rng.weighted(methodEntries);
    const lossType = rng.weighted(lossTypeEntries);

    const reasonCode =
      lossType === 'checkout_abandonment'
        ? rng.pick(ABANDONMENT_CODES[method])
        : drawReasonCode(rng, scenario, method);

    // Sanity: the generator must never emit a code the taxonomy cannot classify.
    if (!lookupReason(reasonCode)) {
      throw new Error(`Generated unknown reason code "${reasonCode}"`);
    }

    // Receivables are B2B invoices and run an order of magnitude larger.
    const amountScale = lossType === 'receivable' ? 12 : 1;
    const amountPaise = Math.max(
      1000,
      Math.round(
        rng.logNormal(scenario.medianAmountPaise * amountScale, scenario.amountSigma),
      ),
    );

    events.push({
      id: `loss_${i.toString().padStart(5, '0')}`,
      lossType,
      merchantId: `merch_${rng.int(1, 12).toString().padStart(3, '0')}`,
      customer: buildCustomer(rng, scenario, i),
      amountPaise,
      method,
      reasonCode,
      occurredAt: startAt + Math.floor(rng.next() * scenario.windowMs),
      debitStatus: deriveDebitStatus(lossType, reasonCode),
    });
  }

  // Chronological order: the engine processes a stream, not a random bag.
  events.sort((a, b) => a.occurredAt - b.occurredAt);
  return events;
}

export interface CohortSummary {
  readonly count: number;
  readonly totalAtRiskPaise: number;
  readonly byRecoveryClass: Readonly<Record<string, number>>;
  readonly byMethod: Readonly<Record<string, number>>;
  readonly byLossType: Readonly<Record<string, number>>;
}

export function summariseCohort(events: readonly LossEvent[]): CohortSummary {
  const byRecoveryClass: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  const byLossType: Record<string, number> = {};
  let totalAtRiskPaise = 0;

  for (const e of events) {
    totalAtRiskPaise += e.amountPaise;
    byMethod[e.method] = (byMethod[e.method] ?? 0) + 1;
    byLossType[e.lossType] = (byLossType[e.lossType] ?? 0) + 1;

    const cls = e.reasonCode ? lookupReason(e.reasonCode)?.recoveryClass : undefined;
    const key = cls ?? 'UNKNOWN';
    byRecoveryClass[key] = (byRecoveryClass[key] ?? 0) + 1;
  }

  return {
    count: events.length,
    totalAtRiskPaise,
    byRecoveryClass,
    byMethod,
    byLossType,
  };
}
