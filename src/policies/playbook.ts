import type { RecoveryClass } from '../domain/failure-taxonomy.js';
import { DAY, HOUR, MINUTE, type Channel, type Paise } from '../domain/types.js';

/**
 * The agent's BELIEFS about how recovery works, and the playbook it runs.
 *
 * ============================ INTEGRITY NOTE ============================
 * This file must never import from `src/sim/recovery-model.ts`.
 *
 * The simulator holds the ground truth: the real probability that a retry
 * succeeds at a given moment. If the agent read those curves it would be
 * grading its own exam, and any result would be meaningless.
 *
 * So the agent carries its own independent estimates, written from what a
 * payments engineer could reasonably infer from Razorpay's public error
 * documentation alone. They are deliberately approximate and, in places,
 * deliberately wrong: `TRANSIENT_FUNDS` is believed to peak at 24h when the
 * simulator actually peaks nearer 30h.
 *
 * The agent has to win with imperfect beliefs, because that is the only kind
 * anyone has in production.
 * =======================================================================
 */

/**
 * When the agent believes a retry is worth making, expressed as delays from the
 * original failure. Derived from the documented meaning of each error class.
 */
export interface Playbook {
  readonly recoveryClass: RecoveryClass;
  /**
   * Retry offsets from the original failure. An empty schedule means the agent
   * believes no retry can ever succeed, and it will not spend a single attempt.
   */
  readonly retrySchedule: readonly number[];
  /** Escalation ladder, cheapest and least intrusive first. */
  readonly channelLadder: readonly Channel[];
  /** The agent's estimate of P(retry succeeds) at the best moment in its schedule. */
  readonly believedPeakOdds: number;
  /** Whether a nudge is what unlocks recovery, rather than merely helping. */
  readonly nudgeIsThePath: boolean;
  /** Why this playbook looks the way it does. Surfaces in the ledger. */
  readonly reasoning: string;
}

export const PLAYBOOKS: Readonly<Record<RecoveryClass, Playbook>> = {
  /**
   * A bank or gateway was down. The customer did nothing wrong and does not
   * need to hear from us at all: telling someone their payment failed because
   * of our infrastructure invites them to reconsider the purchase.
   *
   * Wait for the outage to clear, then retry quietly.
   */
  TRANSIENT_INFRA: {
    recoveryClass: 'TRANSIENT_INFRA',
    retrySchedule: [30 * MINUTE, 2 * HOUR, 6 * HOUR],
    channelLadder: [],
    believedPeakOdds: 0.7,
    nudgeIsThePath: false,
    reasoning:
      'Infrastructure failure, not a customer problem. Retry silently once the outage has had time to clear; contacting the customer would only add doubt.',
  },

  /**
   * Empty account or exhausted daily limit. Only time fixes it, on a scale of
   * days rather than minutes. One polite heads-up is worth sending, because a
   * customer who knows the payment failed may top up deliberately.
   */
  TRANSIENT_FUNDS: {
    recoveryClass: 'TRANSIENT_FUNDS',
    retrySchedule: [20 * HOUR, 44 * HOUR, 3 * DAY],
    channelLadder: ['email', 'whatsapp'],
    believedPeakOdds: 0.5,
    nudgeIsThePath: false,
    reasoning:
      'Needs a balance top-up or a daily limit reset. Retrying inside the hour wastes an attempt; a day later is when it lands.',
  },

  /**
   * The instrument is unusable. THIS IS THE CLASS THAT DEFINES THE AGENT.
   *
   * An expired card cannot be charged, ever, no matter how many times you try.
   * Every retry here is pure waste, so the schedule is empty. The only route to
   * the money is persuading the customer to fix the instrument, after which a
   * retry becomes worth making.
   */
  CUSTOMER_ACTION_REQUIRED: {
    recoveryClass: 'CUSTOMER_ACTION_REQUIRED',
    retrySchedule: [],
    channelLadder: ['email', 'whatsapp', 'sms'],
    believedPeakOdds: 0.8,
    nudgeIsThePath: true,
    reasoning:
      'The instrument itself is dead. No retry can succeed until the customer replaces it, so spend nothing on attempts and everything on a clear nudge.',
  },

  /**
   * The customer walked away mid-checkout. Intent is real but perishable, so
   * speed beats patience here: this is the one class where retrying immediately
   * is correct.
   */
  ABANDONMENT: {
    recoveryClass: 'ABANDONMENT',
    retrySchedule: [2 * MINUTE, 45 * MINUTE],
    channelLadder: ['email', 'whatsapp'],
    believedPeakOdds: 0.4,
    nudgeIsThePath: false,
    reasoning:
      'Purchase intent decays by the hour. Re-engage while they are still in the moment; a reminder tomorrow is a reminder they already moved on.',
  },

  /**
   * A mistyped CVV or fumbled OTP. They can simply try again, but they need a
   * moment to get back to it.
   */
  AUTH_FAILURE: {
    recoveryClass: 'AUTH_FAILURE',
    retrySchedule: [12 * MINUTE, 4 * HOUR, 20 * HOUR],
    channelLadder: ['email', 'whatsapp'],
    believedPeakOdds: 0.6,
    nudgeIsThePath: false,
    reasoning:
      'A corrected attempt works, but not in the same second. Give them a beat, then prompt if it is still unpaid.',
  },

  /**
   * The bank refused with prejudice. Retrying is futile AND harmful: repeated
   * authorisation attempts against a flagged instrument can damage the
   * merchant's standing with the issuer.
   *
   * The agent stops. Doing nothing is the correct, active choice.
   */
  HARD_DECLINE: {
    recoveryClass: 'HARD_DECLINE',
    retrySchedule: [],
    channelLadder: [],
    believedPeakOdds: 0.02,
    nudgeIsThePath: false,
    reasoning:
      'Fraud flag or blocked instrument. Retrying cannot succeed and repeated attempts risk the merchant’s authorisation rates. Stop, and route to risk review if the amount warrants a human.',
  },
};

/**
 * Below this, a case is not worth a human's time no matter what.
 * Rs 2,000.
 */
export const HUMAN_ESCALATION_FLOOR_PAISE: Paise = 200_000;

/**
 * The agent only spends on an action when the expected gain clears the cost by
 * this multiple. A bare break-even threshold would have it acting on coin flips.
 */
export const EV_MARGIN = 3;

/**
 * What one point of customer annoyance is worth, in paise. Rs 20.
 *
 * This is the exchange rate between the two currencies the agent spends:
 * rupees, and the merchant's relationship with their customer. Without it the
 * agent optimises rupees alone, and since recovery dwarfs message costs by two
 * orders of magnitude, the rupee-optimal policy is to contact everyone on the
 * loudest channel available. That is how you win a benchmark and lose a
 * merchant.
 *
 * Pricing annoyance makes restraint fall out of the same arithmetic as
 * everything else, rather than being bolted on as a special case. The specific
 * figure is a judgement call, and the sensitivity of results to it is worth
 * stating openly: raise it and the agent goes quiet, lower it and it gets
 * pushy.
 */
export const SPAM_POINT_PRICE_PAISE: Paise = 2_000;

/**
 * The agent's estimate of how often a nudge on each channel actually persuades
 * the customer to act.
 *
 * Independent of the simulator's true effectiveness figures, and close to but
 * not identical with them. The agent is meant to be roughly right, not
 * clairvoyant.
 */
export const BELIEVED_NUDGE_ODDS: Readonly<Record<Channel, number>> = {
  email: 0.2,
  sms: 0.25,
  whatsapp: 0.35,
  voice: 0.5,
};

/**
 * Expected value of an action, in paise.
 *
 * Deliberately crude: amount x believed odds. The agent is not trying to be a
 * precise forecaster, it is trying to avoid spending Rs 15 on a voice call to
 * recover Rs 40.
 */
export function expectedGainPaise(amountPaise: Paise, believedOdds: number): number {
  return amountPaise * believedOdds;
}

/**
 * Expected value of CONTACTING a customer, which is a two-step gamble: the
 * message has to land AND the resulting retry has to succeed.
 *
 * Scoring a contact with the retry odds alone was a real bug in an earlier
 * version. It overstated every message by roughly 3-5x and made the agent far
 * pushier than its own arithmetic justified, because it was pricing a certainty
 * it did not have.
 */
export function expectedContactGainPaise(
  amountPaise: Paise,
  believedRetryOdds: number,
  channel: Channel,
): number {
  return amountPaise * BELIEVED_NUDGE_ODDS[channel] * believedRetryOdds;
}

/**
 * True cost of an action: what it costs to send, plus what it costs in goodwill.
 */
export function fullCostPaise(
  directCostPaise: Paise,
  spamPoints: number,
  annoyancePricePaise: Paise = SPAM_POINT_PRICE_PAISE,
): number {
  return directCostPaise + spamPoints * annoyancePricePaise;
}

/**
 * Does the expected gain justify this action, counting both currencies?
 *
 * The consequence worth understanding: intrusiveness now scales with the money
 * at stake. A Rs 400 abandoned cart earns an email and nothing more. A
 * Rs 40,000 receivable earns a WhatsApp message, because there the annoyance is
 * actually worth it. The agent is not uniformly polite or uniformly pushy; it
 * is proportionate.
 */
export function worthSpending(
  amountPaise: Paise,
  believedOdds: number,
  directCostPaise: Paise,
  spamPoints = 0,
): boolean {
  const cost = fullCostPaise(directCostPaise, spamPoints);
  if (cost <= 0) return true;
  return expectedGainPaise(amountPaise, believedOdds) > cost * EV_MARGIN;
}

/** As `worthSpending`, but for a contact, whose payoff is a two-step gamble. */
export function worthContacting(
  amountPaise: Paise,
  believedRetryOdds: number,
  channel: Channel,
  directCostPaise: Paise,
  spamPoints: number,
  annoyancePricePaise: Paise = SPAM_POINT_PRICE_PAISE,
): boolean {
  const cost = fullCostPaise(directCostPaise, spamPoints, annoyancePricePaise);
  if (cost <= 0) return true;
  return expectedContactGainPaise(amountPaise, believedRetryOdds, channel) > cost * EV_MARGIN;
}
