import type { PaymentMethod } from '../domain/failure-taxonomy.js';
import type { Channel, LossType, Paise } from '../domain/types.js';

/**
 * A scenario fully determines a simulated cohort. Everything that shapes the
 * numbers lives here, so a reader can see exactly what was assumed without
 * reading the generator.
 */
export interface Scenario {
  readonly id: string;
  readonly name: string;
  /** Shown in the dashboard and the video. Say what this world looks like. */
  readonly description: string;
  readonly seed: number;
  readonly cohortSize: number;

  /** Relative weights. Need not sum to 1. */
  readonly methodMix: Readonly<Partial<Record<PaymentMethod, number>>>;
  readonly lossTypeMix: Readonly<Partial<Record<LossType, number>>>;
  /** Keyed by Razorpay reason code. Codes not valid for a drawn method are skipped. */
  readonly failureMix: Readonly<Record<string, number>>;

  /** Median transaction value in paise, with log-normal spread. */
  readonly medianAmountPaise: Paise;
  readonly amountSigma: number;

  /** Share of customers on the do-not-disturb registry. */
  readonly dndRate: number;
  /** Per-channel opt-in rate across the cohort. */
  readonly consentRates: Readonly<Record<Channel, number>>;
  /** Share of customers who will act on a nudge to fix their instrument. */
  readonly nudgeResponseRate: number;

  /** Wall-clock window over which losses occur. */
  readonly windowMs: number;
}

/**
 * Costs of acting. Recovery is not free, which is the whole reason a bounded
 * policy beats an unbounded one.
 */
export interface CostModel {
  /** Gateway cost of one payment re-attempt. */
  readonly retryCostPaise: Paise;
  /**
   * Cost of one outbound contact. Includes the direct send cost and a modelled
   * goodwill cost, which is why voice is expensive out of proportion to its
   * per-message price.
   */
  readonly contactCostPaise: Readonly<Record<Channel, Paise>>;
  /** Cost of putting a case in front of a human. */
  readonly humanReviewCostPaise: Paise;
  /**
   * Penalty for re-attempting a payment the issuer declined with prejudice.
   *
   * Card networks charge fees for excessive retries against declined
   * authorisations, and a merchant who keeps hammering flagged instruments sees
   * their overall authorisation rate suffer. We assert in ADR 0003 and the
   * README that this cost exists; modelling it is the difference between an
   * argument and a measurement.
   *
   * Applied identically to every strategy, so it advantages no one -- it simply
   * stops the simulation rewarding behaviour we describe as harmful.
   */
  readonly hardDeclineRetryPenaltyPaise: Paise;
}

export const DEFAULT_COSTS: CostModel = {
  retryCostPaise: 250, // Rs 2.50 per attempt
  contactCostPaise: {
    email: 20, // Rs 0.20
    sms: 100, // Rs 1.00
    whatsapp: 80, // Rs 0.80
    voice: 1500, // Rs 15.00 - telephony plus a real goodwill cost
  },
  humanReviewCostPaise: 5000, // Rs 50.00 of an agent's time
  hardDeclineRetryPenaltyPaise: 5000, // Rs 50.00 of network fee and auth-rate damage
};

/**
 * The everyday mix. UPI-dominant, as Indian digital payments are, with
 * insufficient funds and bank downtime as the two most common failure reasons.
 */
const BASELINE_FAILURE_MIX: Record<string, number> = {
  insufficient_funds: 22,
  bank_technical_error: 16,
  gateway_technical_error: 9,
  payment_timed_out: 9,
  payment_cancelled: 8,
  payment_collect_request_expired: 7,
  authentication_failed: 6,
  card_declined: 5,
  payment_declined: 5,
  incorrect_cvv: 3,
  transaction_limit_exceeded: 3,
  invalid_vpa: 3,
  card_expired: 2,
  credit_failed: 2,
  card_not_enrolled: 1.5,
  vpa_resolution_failed: 1.5,
  debit_instrument_inactive: 1,
  card_disabled_for_online_payments: 1,
  payment_failed: 1,
  payment_risk_check_failed: 0.8,
  debit_instrument_blocked: 0.5,
};

const BASE: Omit<Scenario, 'id' | 'name' | 'description' | 'failureMix'> = {
  seed: 42,
  cohortSize: 500,
  methodMix: { upi: 68, card: 32 },
  lossTypeMix: {
    payment_failure: 60,
    checkout_abandonment: 18,
    subscription_mandate: 12,
    receivable: 10,
  },
  medianAmountPaise: 85_000, // Rs 850
  amountSigma: 1.1,
  dndRate: 0.18,
  consentRates: { email: 0.92, sms: 0.74, whatsapp: 0.61, voice: 0.34 },
  nudgeResponseRate: 0.55,
  windowMs: 24 * 60 * 60 * 1000,
};

/** Merge a partial failure mix over the baseline. */
function mixWith(overrides: Record<string, number>): Record<string, number> {
  return { ...BASELINE_FAILURE_MIX, ...overrides };
}

export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  /** The default world. Everything else is a deviation from this. */
  'baseline-week': {
    ...BASE,
    id: 'baseline-week',
    name: 'Baseline week',
    description:
      'An ordinary trading week. UPI-heavy, with insufficient funds and bank downtime as the leading failure reasons.',
    failureMix: BASELINE_FAILURE_MIX,
  },

  /**
   * The demo scenario. One bank falls over and infra failures dominate. A
   * reason-aware policy should shine here: almost everything is recoverable
   * with a short wait, and a fixed 72-hour schedule wastes that window.
   */
  'bank-outage': {
    ...BASE,
    id: 'bank-outage',
    name: 'Bank outage',
    description:
      'A major partner bank goes down for part of the day. Most failures are transient infrastructure and highly recoverable, but only if you wait for the outage to clear rather than hammering it.',
    seed: 1337,
    windowMs: 6 * 60 * 60 * 1000,
    failureMix: mixWith({
      bank_technical_error: 120,
      gateway_technical_error: 60,
      payment_timed_out: 25,
      credit_failed: 18,
    }),
  },

  /**
   * Month-end. Wallets are empty and daily limits are hit. Recovery is real but
   * slow, so any policy that gives up inside a day leaves money behind.
   */
  'month-end-squeeze': {
    ...BASE,
    id: 'month-end-squeeze',
    name: 'Month-end squeeze',
    description:
      'The days before payday. Insufficient funds and exhausted daily limits dominate. The money is recoverable, but only on a multi-day horizon.',
    seed: 909,
    failureMix: mixWith({
      insufficient_funds: 95,
      transaction_limit_exceeded: 30,
    }),
  },

  /**
   * Adversarial. Hard declines and risk flags spike. The correct behaviour is
   * mostly to STOP, and a policy that keeps retrying will burn money and trip
   * issuer risk controls. Tests restraint rather than aggression.
   */
  'risk-spike': {
    ...BASE,
    id: 'risk-spike',
    name: 'Risk spike',
    description:
      'A wave of fraud-flagged and blocked-instrument declines. Nearly nothing here is recoverable. The right answer is to stop early, and a naive retry loop is actively harmful.',
    seed: 5150,
    failureMix: mixWith({
      payment_risk_check_failed: 55,
      debit_instrument_blocked: 40,
      card_declined: 35,
      payment_declined: 30,
    }),
  },

  /**
   * Instrument rot: expired cards and unregistered VPAs. Retrying is futile by
   * construction; the only path to the money is a nudge that lands.
   */
  'stale-instruments': {
    ...BASE,
    id: 'stale-instruments',
    name: 'Stale instruments',
    description:
      'Expired cards, deregistered VPAs and disabled online payments. No retry can ever succeed here. Every rupee recovered has to come through a customer nudge.',
    seed: 2718,
    failureMix: mixWith({
      card_expired: 45,
      card_not_enrolled: 25,
      invalid_vpa: 30,
      debit_instrument_inactive: 20,
      card_disabled_for_online_payments: 18,
      vpa_resolution_failed: 15,
    }),
  },
};

export function getScenario(id: string): Scenario {
  const scenario = SCENARIOS[id];
  if (!scenario) {
    const known = Object.keys(SCENARIOS).join(', ');
    throw new Error(`Unknown scenario "${id}". Known scenarios: ${known}`);
  }
  return scenario;
}

export const SCENARIO_IDS: readonly string[] = Object.keys(SCENARIOS);
