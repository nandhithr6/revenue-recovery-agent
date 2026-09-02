import { DAY, type Channel, type LossType, type Paise } from '../domain/types.js';

/**
 * Per-loss-type modulation of the recovery playbook.
 *
 * The recovery CLASS says what is wrong with the payment. The loss TYPE says
 * what you are even allowed to do about it, and the two are independent.
 *
 * The distinction that makes this layer necessary: **you cannot silently retry
 * a charge you have no authorisation to make.**
 *
 *   - A failed payment on a live checkout: the customer authorised it, so
 *     re-attempting is legitimate.
 *   - A subscription mandate: there is a standing authorisation, so retries are
 *     not merely allowed but expected, over a longer horizon.
 *   - An abandoned checkout: nothing was ever authorised. There is no charge to
 *     retry. The only move is to bring the customer back.
 *   - A B2B receivable: an invoice, not a card. Nothing to retry at all, and the
 *     recovery motion is a conversation with an accounts-payable department.
 *
 * A single playbook applied to all four would cheerfully "retry" an invoice.
 */

export interface LossProfile {
  readonly lossType: LossType;
  readonly label: string;
  /**
   * Whether re-attempting the charge is possible at all. When false, the retry
   * schedule is discarded regardless of what the recovery class suggests.
   */
  readonly canRetryCharge: boolean;
  /** Multiplier on the class retry schedule. Mandates can afford patience. */
  readonly retryDelayScale: number;
  /** Extra retries permitted beyond the class schedule. */
  readonly extraRetries: number;
  /** Channels appended to the class ladder, for motions that need them. */
  readonly extraChannels: readonly Channel[];
  /**
   * Whether a landed contact should be treated as a promise to pay, tracked and
   * followed up if broken.
   */
  readonly tracksPromiseToPay: boolean;
  /** How long to honour a promise before treating it as broken. */
  readonly promiseWindowMs: number;
  /** Escalate to a human above this amount. Receivables justify it far sooner. */
  readonly humanFloorPaise: Paise;
  readonly reasoning: string;
}

export const LOSS_PROFILES: Readonly<Record<LossType, LossProfile>> = {
  /**
   * A live payment that failed. The customer authorised the charge, so
   * re-attempting it is legitimate. This is the baseline motion.
   */
  payment_failure: {
    lossType: 'payment_failure',
    label: 'Payment failure',
    canRetryCharge: true,
    retryDelayScale: 1,
    extraRetries: 0,
    extraChannels: [],
    tracksPromiseToPay: false,
    promiseWindowMs: 0,
    humanFloorPaise: 200_000,
    reasoning: 'The customer authorised this charge, so re-attempting it is legitimate.',
  },

  /**
   * The customer left before authorising anything. There is no charge to retry
   * -- a "retry" here would be charging someone who never agreed to pay.
   *
   * The entire motion is re-engagement, and it is urgent: intent decays hourly.
   */
  checkout_abandonment: {
    lossType: 'checkout_abandonment',
    label: 'Checkout drop-off',
    canRetryCharge: false,
    retryDelayScale: 1,
    extraRetries: 0,
    extraChannels: ['whatsapp'],
    tracksPromiseToPay: false,
    promiseWindowMs: 0,
    humanFloorPaise: 1_000_000,
    reasoning:
      'Nothing was authorised, so there is no charge to retry. Recovery means bringing the customer back, quickly, before the intent goes.',
  },

  /**
   * A standing mandate exists, so retries are expected rather than merely
   * permitted -- this is the mandate retry sequencer. The horizon is longer
   * because the relationship is ongoing: a subscriber whose payment fails today
   * is still a subscriber next week.
   *
   * Chasing them hard is counterproductive; chasing them patiently is correct.
   */
  subscription_mandate: {
    lossType: 'subscription_mandate',
    label: 'Subscription / mandate',
    canRetryCharge: true,
    retryDelayScale: 1.8,
    extraRetries: 2,
    extraChannels: [],
    tracksPromiseToPay: false,
    promiseWindowMs: 0,
    humanFloorPaise: 500_000,
    reasoning:
      'A standing mandate authorises repeated attempts, and an ongoing subscriber is worth patience rather than pressure.',
  },

  /**
   * An unpaid invoice. There is no instrument to charge, so retries are
   * meaningless. Recovery is a conversation with a person who has to schedule a
   * payment run -- which is why promise-to-pay tracking lives here and nowhere
   * else.
   */
  receivable: {
    lossType: 'receivable',
    label: 'B2B receivable',
    canRetryCharge: false,
    retryDelayScale: 1,
    extraRetries: 0,
    extraChannels: ['email', 'whatsapp', 'sms'],
    tracksPromiseToPay: true,
    promiseWindowMs: 5 * DAY,
    humanFloorPaise: 300_000,
    reasoning:
      'An invoice, not a charge. Nothing can be retried; recovery is a chase, and a commitment to pay is worth tracking and following up.',
  },
};

