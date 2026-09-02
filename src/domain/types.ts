import type { PaymentMethod, RecoveryClass } from './failure-taxonomy.js';

/**
 * All money is in paise (integer). Currency never touches a float in this
 * codebase; rounding errors in a recovery ledger are indefensible.
 */
export type Paise = number;

export const rupees = (paise: Paise): number => paise / 100;
export const formatINR = (paise: Paise): string =>
  `Rs ${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

/** Milliseconds since epoch. */
export type Timestamp = number;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * The kinds of revenue loss this engine handles. The pipeline is identical for
 * each; only detection and the available interventions differ.
 */
export type LossType =
  | 'payment_failure'
  | 'checkout_abandonment'
  | 'subscription_mandate'
  | 'receivable';

/** Channels we can reach a customer on, cheapest and least intrusive first. */
export type Channel = 'email' | 'sms' | 'whatsapp' | 'voice';

export const CHANNELS: readonly Channel[] = ['email', 'sms', 'whatsapp', 'voice'];

export interface CustomerProfile {
  readonly id: string;
  /** Registered on the national do-not-disturb list. Blocks outbound contact. */
  readonly dndRegistered: boolean;
  /** Per-channel opt-in. Contact without consent is a compliance violation. */
  readonly consent: Readonly<Record<Channel, boolean>>;
  /** Minutes offset from UTC, for quiet-hours evaluation in local time. */
  readonly utcOffsetMinutes: number;
  /**
   * Whether this customer will act on a nudge asking them to fix something
   * (update an expired card, register a VPA). Drives CUSTOMER_ACTION_REQUIRED
   * recovery. Simulation-only ground truth; the agent never sees it.
   */
  readonly respondsToNudge: boolean;
}

/** A unit of revenue at risk. The input to the whole pipeline. */
export interface LossEvent {
  readonly id: string;
  readonly lossType: LossType;
  readonly merchantId: string;
  readonly customer: CustomerProfile;
  readonly amountPaise: Paise;
  readonly method: PaymentMethod;
  /** Razorpay failure reason code. Absent for abandonment-style losses. */
  readonly reasonCode: string | undefined;
  readonly occurredAt: Timestamp;
}

/** What the agent decided to do. */
export type ActionKind =
  /** Re-attempt the charge on the same instrument. */
  | 'retry_payment'
  /** Reach out to the customer on a channel. */
  | 'contact_customer'
  /** Deliberately do nothing more, for a stated reason. */
  | 'stop'
  /** Hand to a human. */
  | 'escalate_human';

export interface Action {
  readonly kind: ActionKind;
  /** For contact_customer. */
  readonly channel?: Channel;
  /** Delay from now before the action should fire. */
  readonly delayMs: number;
  /** Why the policy chose this. Written to the ledger verbatim. */
  readonly rationale: string;
}

/** Ground-truth diagnosis the simulator knows; the agent must infer it. */
export interface Diagnosis {
  readonly recoveryClass: RecoveryClass;
  readonly reasonCode: string | undefined;
  readonly confidence: number;
  readonly rationale: string;
}

export interface AttemptOutcome {
  readonly succeeded: boolean;
  readonly recoveredPaise: Paise;
}
