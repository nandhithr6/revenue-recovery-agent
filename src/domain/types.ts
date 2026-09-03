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

/**
 * Whether the customer's money actually left their account before this
 * failure was recorded -- a real, distinct question from "did the payment
 * succeed," and one this codebase did not previously represent at all
 * (there was no field for it anywhere; auditing it honestly meant adding
 * one, not inferring it after the fact from `recovered`).
 *
 *   - `no_debit`: the bank/network gave a DEFINITIVE refusal (or the
 *     customer never reached authorisation at all). No capture occurred.
 *     This is how card and UPI authorisation actually works -- a decline
 *     response means the hold/capture step was never reached -- and is
 *     true for the large majority of this taxonomy's reason codes.
 *   - `uncertain`: no definitive response was ever received. The
 *     authorisation may have completed asynchronously on the bank's side
 *     after the merchant's request timed out; whether it did is genuinely
 *     unknown at the moment this failure is recorded. `payment_timed_out`
 *     is the one reason code in this taxonomy that means this, and only
 *     when there is a real charge behind it to retry (a
 *     `checkout_abandonment` timeout never reached authorisation in the
 *     first place, so it carries no such risk).
 *   - `debited`: money left the account and the failure is downstream of
 *     that (a decline, chargeback, or reversal after capture). This
 *     simulator does not currently generate any case in this state -- see
 *     the note on `deriveDebitStatus` in `sim/generator.ts` for why, said
 *     plainly rather than left implicit.
 */
export type DebitStatus = 'no_debit' | 'uncertain' | 'debited';

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
  readonly debitStatus: DebitStatus;
}

/** What the agent decided to do. */
export type ActionKind =
  /** Re-attempt the charge on the same instrument. */
  | 'retry_payment'
  /** Reach out to the customer on a channel. */
  | 'contact_customer'
  /** Deliberately do nothing more, for a stated reason. Ends the case. */
  | 'stop'
  /** Hand to a human. */
  | 'escalate_human'
  /**
   * Pause and re-decide later -- for "not yet, but not never." Distinct from
   * `stop`: a case that stops is done for good, a case that waits comes back.
   * Costs nothing, touches no customer, never faces a guardrail.
   *
   * Exists because `stop` was once used for this and quietly ended cases that
   * should have resumed: a receivable that landed a promise-to-pay returned
   * `stop` while honouring the grace window, which terminated the case on the
   * spot instead of coming back once the promise lapsed. See engineering log.
   */
  | 'wait';

export interface Action {
  readonly kind: ActionKind;
  /** For contact_customer. */
  readonly channel?: Channel;
  /** Delay from now before the action should fire. */
  readonly delayMs: number;
  /** Why the policy chose this. Written to the ledger verbatim. */
  readonly rationale: string;
}

/**
 * A structured outcome from a two-way contact, as opposed to the plain
 * succeeded/failed boolean every other channel resolves to.
 *
 * Only voice produces one of these today (see `sim/voice-signal-model.ts` for
 * where it's drawn from, and `policies/adaptive-agent.ts` for how a policy
 * reacts to one). The set is deliberately small: each member exists because a
 * policy does something DIFFERENT in response to it, not because it sounds
 * like a plausible thing a customer might say. Anything a policy would treat
 * identically to `no_answer` isn't worth a separate case.
 */
export type CustomerSignal =
  /** Committed to pay, without giving a specific reason things changed. */
  | { readonly kind: 'promise_to_pay' }
  /** The original blocker (funds) is explicitly resolved now. */
  | { readonly kind: 'funds_available_now' }
  /** The original blocker (a dead instrument) is explicitly fixed now. */
  | { readonly kind: 'instrument_fixed' }
  /** Customer contests the charge. A reason to stop, not to try harder. */
  | { readonly kind: 'disputes_charge' }
  /** Customer declines to engage further. */
  | { readonly kind: 'refused' }
  /** Call did not connect. No information gained either way. */
  | { readonly kind: 'no_answer' };

/**
 * One priced candidate action, flattened for display -- the same numbers
 * `policies/action-registry.ts:Candidate` computes, minus the full `Action`
 * object (redundant with the ledger/trace entry for the winner, and not
 * needed for the ones that weren't chosen). Lives in `domain/` rather than
 * `eval/trace.ts` or `policies/` specifically so both `ledger/ledger.ts` and
 * `eval/trace.ts` can depend on it without either depending on the other.
 */
export interface CandidateSummary {
  readonly kind: ActionKind;
  readonly channel?: Channel;
  readonly grossRecoveryPaise: Paise;
  readonly costPaise: Paise;
  readonly spamPoints: number;
  readonly expectedValuePaise: Paise;
  readonly dominated?: boolean;
  readonly chosen: boolean;
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
