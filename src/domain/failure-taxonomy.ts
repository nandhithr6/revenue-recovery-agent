/**
 * Razorpay failure-reason taxonomy.
 *
 * The `reason` codes below are Razorpay's own documented payment error reasons
 * for cards and UPI. See docs/SOURCES.md for provenance.
 *
 * What is NOT from Razorpay, and is our own modelling contribution:
 *   - the RecoveryClass each reason maps to
 *   - the retry/nudge guidance attached to each class
 * These are hand-specified from the documented "next steps" plus payments
 * domain reasoning, and are stated as assumptions, not measurements.
 */

/** How a failed payment can (or cannot) be turned into a successful one. */
export type RecoveryClass =
  /** Infrastructure blipped. Nothing is wrong with the customer or the card. */
  | 'TRANSIENT_INFRA'
  /** Money was not there, or a limit was hit. Time is the fix, not a new card. */
  | 'TRANSIENT_FUNDS'
  /** Retrying the same instrument can never work. The customer must change something. */
  | 'CUSTOMER_ACTION_REQUIRED'
  /** Customer walked away mid-flow. Intent may still exist; re-engage. */
  | 'ABANDONMENT'
  /** Customer fumbled a credential. A corrected attempt can work. */
  | 'AUTH_FAILURE'
  /** Bank or risk engine said no, with prejudice. Do not push. */
  | 'HARD_DECLINE';

export type PaymentMethod = 'card' | 'upi';

/** Who the failure originated with, per Razorpay's `source` concept. */
export type FailureSource = 'customer' | 'bank' | 'gateway' | 'network';

export interface FailureReason {
  /** Razorpay's documented `reason` string. */
  readonly code: string;
  readonly methods: readonly PaymentMethod[];
  readonly source: FailureSource;
  readonly recoveryClass: RecoveryClass;
  /** Human-readable, adapted from Razorpay's description. */
  readonly description: string;
}

export const FAILURE_REASONS = [
  // ------------------------------------------------------------- infra
  {
    code: 'bank_technical_error',
    methods: ['card', 'upi'],
    source: 'bank',
    recoveryClass: 'TRANSIENT_INFRA',
    description: 'The customer bank experienced service downtime.',
  },
  {
    code: 'gateway_technical_error',
    methods: ['card', 'upi'],
    source: 'gateway',
    recoveryClass: 'TRANSIENT_INFRA',
    description: 'Partner bank experienced downtime affecting payment processing.',
  },
  {
    code: 'credit_failed',
    methods: ['upi'],
    source: 'bank',
    recoveryClass: 'TRANSIENT_INFRA',
    description: 'Wrong account selected, or partner bank downtime occurred.',
  },
  {
    code: 'bank_not_available',
    methods: ['card', 'upi'],
    source: 'bank',
    recoveryClass: 'TRANSIENT_INFRA',
    description: 'The issuing bank is unavailable due to downtime or a technical issue.',
  },
  {
    code: 'bank_cutoff_in_progress',
    methods: ['card', 'upi'],
    source: 'bank',
    recoveryClass: 'TRANSIENT_INFRA',
    description: "The bank's core banking system is in its periodic end-of-day cutoff window.",
  },
  {
    code: 'issuer_technical_error',
    methods: ['card', 'upi'],
    source: 'bank',
    recoveryClass: 'TRANSIENT_INFRA',
    description: 'A technical error occurred at the card or account issuer.',
  },
  {
    code: 'upi_app_technical_error',
    methods: ['upi'],
    source: 'gateway',
    recoveryClass: 'TRANSIENT_INFRA',
    description: "A technical error occurred at the customer's UPI app (PSP).",
  },

  // ------------------------------------------------------------- funds
  {
    code: 'insufficient_funds',
    methods: ['card', 'upi'],
    source: 'customer',
    recoveryClass: 'TRANSIENT_FUNDS',
    description: 'The customer bank account did not have enough funds.',
  },
  {
    code: 'transaction_limit_exceeded',
    methods: ['card'],
    source: 'customer',
    recoveryClass: 'TRANSIENT_FUNDS',
    description: 'The customer reached their daily transaction limit on the card.',
  },
  {
    code: 'transaction_daily_limit_exceeded',
    methods: ['card', 'upi'],
    source: 'customer',
    recoveryClass: 'TRANSIENT_FUNDS',
    description: 'The customer reached their self-set or default daily transaction limit.',
  },
  {
    code: 'transaction_frequency_limit_exceeded',
    methods: ['upi'],
    source: 'customer',
    recoveryClass: 'TRANSIENT_FUNDS',
    description: "The customer exhausted NPCI's per-day UPI transaction frequency limit.",
  },

  // -------------------------------------------------- customer must act
  {
    code: 'card_expired',
    methods: ['card'],
    source: 'customer',
    recoveryClass: 'CUSTOMER_ACTION_REQUIRED',
    description: 'The customer card has expired.',
  },
  {
    code: 'card_not_enrolled',
    methods: ['card'],
    source: 'customer',
    recoveryClass: 'CUSTOMER_ACTION_REQUIRED',
    description: 'Card was not activated or enabled for online transactions.',
  },
  {
    code: 'card_disabled_for_online_payments',
    methods: ['card'],
    source: 'customer',
    recoveryClass: 'CUSTOMER_ACTION_REQUIRED',
    description: 'Card lacks online transaction authorisation.',
  },
  {
    code: 'debit_instrument_inactive',
    methods: ['card'],
    source: 'customer',
    recoveryClass: 'CUSTOMER_ACTION_REQUIRED',
    description: 'Debit card is not enabled for online use.',
  },
  {
    code: 'invalid_vpa',
    methods: ['upi'],
    source: 'customer',
    recoveryClass: 'CUSTOMER_ACTION_REQUIRED',
    description: 'The customer is not a valid user on the UPI app.',
  },
  {
    code: 'vpa_resolution_failed',
    methods: ['upi'],
    source: 'network',
    recoveryClass: 'CUSTOMER_ACTION_REQUIRED',
    description: 'Failure to process the transaction using the customer UPI ID.',
  },

  // -------------------------------------------------------- abandonment
  {
    code: 'payment_cancelled',
    methods: ['card', 'upi'],
    source: 'customer',
    recoveryClass: 'ABANDONMENT',
    description: 'The customer cancelled or pressed back during payment.',
  },
  {
    code: 'payment_timed_out',
    methods: ['card', 'upi'],
    source: 'customer',
    recoveryClass: 'ABANDONMENT',
    description: 'The customer exceeded the time limit for payment processing.',
  },
  {
    code: 'payment_collect_request_expired',
    methods: ['upi'],
    source: 'customer',
    recoveryClass: 'ABANDONMENT',
    description: 'The customer did not act on the collect request in time.',
  },
  {
    code: 'payment_session_expired',
    methods: ['card', 'upi'],
    source: 'customer',
    recoveryClass: 'ABANDONMENT',
    description: 'The customer took too long and the payment session expired.',
  },

  // -------------------------------------------------------- auth fumbles
  {
    code: 'incorrect_cvv',
    methods: ['card'],
    source: 'customer',
    recoveryClass: 'AUTH_FAILURE',
    description: 'The customer entered the wrong CVV at checkout.',
  },
  {
    code: 'authentication_failed',
    methods: ['card'],
    source: 'customer',
    recoveryClass: 'AUTH_FAILURE',
    description: 'Incorrect OTP, or the browser was closed during authentication.',
  },
  {
    code: 'incorrect_otp',
    methods: ['card'],
    source: 'customer',
    recoveryClass: 'AUTH_FAILURE',
    description: 'The customer entered an incorrect OTP.',
  },
  {
    code: 'otp_expired',
    methods: ['card'],
    source: 'customer',
    recoveryClass: 'AUTH_FAILURE',
    description: 'The OTP expired before the customer entered it.',
  },
  {
    code: 'otp_attempts_exceeded',
    methods: ['card'],
    source: 'customer',
    recoveryClass: 'AUTH_FAILURE',
    description: 'The customer exceeded the allowed number of OTP attempts.',
  },
  {
    code: 'incorrect_card_details',
    methods: ['card'],
    source: 'customer',
    recoveryClass: 'AUTH_FAILURE',
    description: 'The customer entered incorrect card details.',
  },
  {
    code: 'incorrect_cardholder_name',
    methods: ['card'],
    source: 'customer',
    recoveryClass: 'AUTH_FAILURE',
    description: 'The customer entered an incorrect cardholder name.',
  },
  {
    code: 'card_number_invalid',
    methods: ['card'],
    source: 'customer',
    recoveryClass: 'AUTH_FAILURE',
    description: 'The card number the customer entered is invalid.',
  },

  // ------------------------------------------------------- hard decline
  {
    code: 'payment_risk_check_failed',
    methods: ['card'],
    source: 'bank',
    recoveryClass: 'HARD_DECLINE',
    description: 'The customer bank declined the payment, citing it as fraudulent.',
  },
  {
    code: 'debit_instrument_blocked',
    methods: ['card'],
    source: 'bank',
    recoveryClass: 'HARD_DECLINE',
    description: 'Card blocked by the customer or the issuing bank.',
  },
  {
    code: 'card_declined',
    methods: ['card'],
    source: 'bank',
    recoveryClass: 'HARD_DECLINE',
    description: 'Payment was declined by the customer bank.',
  },
  {
    code: 'payment_declined',
    methods: ['upi'],
    source: 'bank',
    recoveryClass: 'HARD_DECLINE',
    description: 'Funds could not be debited from the customer bank account.',
  },
  {
    code: 'payment_failed',
    methods: ['card'],
    source: 'bank',
    recoveryClass: 'HARD_DECLINE',
    description: 'Bank declined the transaction without giving a specific reason.',
  },
] as const satisfies readonly FailureReason[];

export type FailureCode = (typeof FAILURE_REASONS)[number]['code'];

/**
 * Widened view of the table. `FAILURE_REASONS` is `as const` so that
 * `FailureCode` stays a precise union; iteration wants the wider element type.
 */
const ALL: readonly FailureReason[] = FAILURE_REASONS;

const BY_CODE: ReadonlyMap<string, FailureReason> = new Map(
  ALL.map((r) => [r.code, r]),
);

export function lookupReason(code: string): FailureReason | undefined {
  return BY_CODE.get(code);
}

/**
 * Reasons applicable to a payment method. Used by the simulator to draw
 * method-appropriate failures: a card never fails with `invalid_vpa`.
 */
export function reasonsForMethod(method: PaymentMethod): readonly FailureReason[] {
  return ALL.filter((r) => r.methods.includes(method));
}
