import { DAY, HOUR, MINUTE } from '../domain/types.js';
import { STOP, type CaseContext, type Strategy } from './types.js';

/**
 * The strategies we have to beat.
 *
 * These are not straw men. `naive-retry` is what a weekend implementation looks
 * like, and `fixed-dunning` is what a great many production dunning systems
 * actually do. Beating "do nothing" proves nothing; beating these proves the
 * reason-aware policy is worth its complexity.
 */

/** The floor. Recovers nothing, costs nothing. */
export const doNothing: Strategy = {
  id: 'do-nothing',
  name: 'Do nothing',
  description: 'Write off every failed payment immediately. The floor: zero recovered, zero spent.',
  decide: () => STOP('policy never acts'),
};

/**
 * Retry three times, immediately, regardless of why the payment failed.
 *
 * Fails in two directions at once: it hammers transient-infra failures while the
 * outage is still ongoing, and it keeps retrying hard declines that can never
 * succeed.
 */
export const naiveRetry: Strategy = {
  id: 'naive-retry',
  name: 'Naive retry',
  description:
    'Retry three times in quick succession, ignoring the failure reason. The obvious implementation.',
  decide: (ctx: CaseContext) => {
    if (ctx.attemptCount >= 3) return STOP('exhausted three immediate retries');
    return {
      kind: 'retry_payment',
      delayMs: ctx.attemptCount === 0 ? 0 : 5 * MINUTE,
      rationale: `blind retry ${ctx.attemptCount + 1} of 3`,
    };
  },
};

/**
 * The classic dunning ladder: retry at +1h, +24h, +72h, then send one email.
 *
 * Reason-blind, but time-aware, which already makes it much better than naive
 * retry. This is the honest benchmark.
 */
const DUNNING_SCHEDULE = [1 * HOUR, 24 * HOUR, 72 * HOUR] as const;

export const fixedDunning: Strategy = {
  id: 'fixed-dunning',
  name: 'Fixed dunning',
  description:
    'Retry on a fixed +1h / +24h / +72h ladder regardless of failure reason, then send a single email.',
  decide: (ctx: CaseContext) => {
    const step = ctx.attemptCount;

    if (step < DUNNING_SCHEDULE.length) {
      const previous = step === 0 ? 0 : DUNNING_SCHEDULE[step - 1]!;
      const delayMs = DUNNING_SCHEDULE[step]! - previous;
      return {
        kind: 'retry_payment',
        delayMs,
        rationale: `fixed schedule retry ${step + 1} at +${DUNNING_SCHEDULE[step]! / HOUR}h`,
      };
    }

    if (ctx.contactCount === 0 && ctx.event.customer.consent.email) {
      return {
        kind: 'contact_customer',
        channel: 'email',
        delayMs: 1 * DAY,
        rationale: 'schedule exhausted, send one reminder email',
      };
    }

    return STOP('fixed dunning schedule complete');
  },
};

export const BASELINE_STRATEGIES: readonly Strategy[] = [
  doNothing,
  naiveRetry,
  fixedDunning,
];
