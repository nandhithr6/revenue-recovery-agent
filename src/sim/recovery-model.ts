import type { RecoveryClass } from '../domain/failure-taxonomy.js';
import { HOUR, MINUTE, DAY } from '../domain/types.js';

/**
 * Ground truth for whether a recovery attempt would succeed.
 *
 * ALL NUMBERS HERE ARE ASSUMPTIONS. They are reasoned from Razorpay's documented
 * "next steps" for each error plus payments domain logic, not measured from real
 * data. See docs/SOURCES.md. The agent never reads this file at runtime; it must
 * infer good timing from the failure reason alone.
 *
 * The design point: each recovery class has a DIFFERENTLY SHAPED curve over
 * elapsed time. That is what makes *when* you retry matter, and therefore what
 * makes a reason-aware policy beat a fixed schedule.
 */

type CurveShape =
  /** Useless immediately, improves as the underlying condition clears. */
  | { readonly kind: 'rise'; readonly pMax: number; readonly tau: number }
  /** Best immediately, fades as intent or context is lost. */
  | { readonly kind: 'decay'; readonly pMax: number; readonly tau: number }
  /** Rises then fades: needs a moment to become possible, then goes stale. */
  | {
      readonly kind: 'rise-then-decay';
      readonly pMax: number;
      readonly riseTau: number;
      readonly decayTau: number;
    }
  /** Effectively never works. */
  | { readonly kind: 'flat'; readonly p: number };

interface ClassModel {
  readonly shape: CurveShape;
  /**
   * If true, a plain retry cannot succeed until the customer has acted on a
   * nudge (updated a card, registered a VPA).
   */
  readonly requiresCustomerAction: boolean;
  readonly reasoning: string;
}

export const RECOVERY_MODEL: Readonly<Record<RecoveryClass, ClassModel>> = {
  /**
   * A bank or gateway was down. Retrying into an ongoing outage fails; waiting
   * for it to clear works well. Outages typically resolve in tens of minutes.
   */
  TRANSIENT_INFRA: {
    shape: { kind: 'rise', pMax: 0.78, tau: 25 * MINUTE },
    requiresCustomerAction: false,
    reasoning:
      'Outage clears on its own. Immediate retry hits the same downtime; a short wait is near-free and highly effective.',
  },

  /**
   * The account was short, or a daily limit was hit. Only time fixes this, and
   * on a much longer scale: a balance top-up or the limit resetting at midnight.
   */
  TRANSIENT_FUNDS: {
    shape: { kind: 'rise', pMax: 0.58, tau: 30 * HOUR },
    requiresCustomerAction: false,
    reasoning:
      'Needs a balance top-up or a daily limit reset. Retrying within the hour is close to worthless; a day or two later is when it lands.',
  },

  /**
   * The instrument itself is unusable. No amount of retrying helps. The only
   * path is persuading the customer to change something.
   */
  CUSTOMER_ACTION_REQUIRED: {
    shape: { kind: 'rise', pMax: 0.85, tau: 10 * MINUTE },
    requiresCustomerAction: true,
    reasoning:
      'Expired card, unregistered VPA. Retrying the same instrument can never succeed. Once the customer fixes it, success is very likely.',
  },

  /**
   * The customer walked away. Purchase intent is real but perishable: it decays
   * over hours, and by a few days later they have usually bought elsewhere or
   * changed their mind.
   */
  ABANDONMENT: {
    shape: { kind: 'decay', pMax: 0.42, tau: 8 * HOUR },
    requiresCustomerAction: false,
    reasoning:
      'Intent is perishable. Re-engage within the hour and a good share convert; a week later the moment has passed.',
  },

  /**
   * A mistyped CVV or a fumbled OTP. The customer can simply try again, but they
   * need a beat to get back to it, and interest fades over days.
   */
  AUTH_FAILURE: {
    shape: {
      kind: 'rise-then-decay',
      pMax: 0.68,
      riseTau: 8 * MINUTE,
      decayTau: 3 * DAY,
    },
    requiresCustomerAction: false,
    reasoning:
      'A corrected attempt works, but not in the same instant. Give them a few minutes, then it slowly goes stale.',
  },

  /**
   * The bank or a risk engine refused with prejudice. Pushing is both futile and
   * a genuine risk signal. The correct action is to stop.
   */
  HARD_DECLINE: {
    shape: { kind: 'flat', p: 0.015 },
    requiresCustomerAction: false,
    reasoning:
      'Fraud flags and blocked instruments do not resolve by retrying. Repeated attempts can themselves trip issuer risk controls.',
  },
};

/** Each additional attempt is less likely to work than the last. */
const ATTEMPT_FATIGUE = 0.72;

function curveValue(shape: CurveShape, elapsedMs: number): number {
  const t = Math.max(0, elapsedMs);
  switch (shape.kind) {
    case 'rise':
      return shape.pMax * (1 - Math.exp(-t / shape.tau));
    case 'decay':
      return shape.pMax * Math.exp(-t / shape.tau);
    case 'rise-then-decay': {
      const rise = 1 - Math.exp(-t / shape.riseTau);
      const decay = Math.exp(-t / shape.decayTau);
      return shape.pMax * rise * decay;
    }
    case 'flat':
      return shape.p;
  }
}

export interface RecoveryOdds {
  /** Probability this attempt succeeds, in [0, 1]. */
  readonly probability: number;
  /** Why, in words. Used for explaining results, never fed to the agent. */
  readonly explanation: string;
}

/**
 * Probability that retrying now succeeds.
 *
 * @param recoveryClass  ground-truth class of the original failure
 * @param elapsedMs      time since the loss event
 * @param attemptIndex   0 for the first retry, 1 for the second, ...
 * @param customerActed  whether the customer has fixed their instrument
 */
export function recoveryOdds(
  recoveryClass: RecoveryClass,
  elapsedMs: number,
  attemptIndex: number,
  customerActed: boolean,
): RecoveryOdds {
  const model = RECOVERY_MODEL[recoveryClass];

  if (model.requiresCustomerAction && !customerActed) {
    return {
      probability: 0.01,
      explanation: `${recoveryClass}: the instrument is unusable until the customer fixes it, so a retry is near-hopeless.`,
    };
  }

  const base = curveValue(model.shape, elapsedMs);
  const fatigue = ATTEMPT_FATIGUE ** attemptIndex;
  const probability = Math.max(0, Math.min(1, base * fatigue));

  const hours = (elapsedMs / HOUR).toFixed(1);
  return {
    probability,
    explanation: `${recoveryClass} at +${hours}h, attempt ${attemptIndex + 1}: ${(probability * 100).toFixed(1)}%`,
  };
}

/**
 * Probability that a nudge on a channel persuades the customer to fix their
 * instrument. Voice is most effective and most intrusive, which is exactly the
 * tension the escalation ladder has to manage.
 */
export const NUDGE_EFFECTIVENESS: Readonly<Record<string, number>> = {
  email: 0.18,
  sms: 0.26,
  whatsapp: 0.38,
  voice: 0.55,
};
