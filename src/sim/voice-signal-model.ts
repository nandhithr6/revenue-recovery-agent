import type { RecoveryClass } from '../domain/failure-taxonomy.js';
import type { CustomerSignal } from '../domain/types.js';
import type { Rng } from './rng.js';

/**
 * Ground truth for what a customer says when a voice call actually connects.
 *
 * Same integrity boundary as `recovery-model.ts`: this is read ONLY by
 * `eval/engine.ts`, never by a policy. A policy sees the drawn `CustomerSignal`
 * on its own case's history after the fact -- an observable outcome, exactly
 * like `succeeded` on every other channel -- never this distribution.
 *
 * ALL WEIGHTS HERE ARE ASSUMPTIONS, same as every other number in `sim/`. They
 * are not measured from real call data (none exists for this project) and are
 * not tuned to make any policy's numbers look better -- they were written
 * once, before `agent-adaptive` was taught to react to any of these signals,
 * specifically so there was no opportunity to shape them around a known
 * response.
 *
 * Design choice: not every signal is possible for every class. A hard-decline
 * customer cannot plausibly say "funds are available now" -- that isn't what
 * was wrong. Offering it anyway would let a policy "discover" a bogus recovery
 * path just because the signal type exists in the union.
 */
const DISTRIBUTION: Readonly<Record<RecoveryClass, ReadonlyMap<CustomerSignal['kind'], number>>> = {
  TRANSIENT_FUNDS: new Map([
    ['promise_to_pay', 0.3],
    ['funds_available_now', 0.2],
    ['no_answer', 0.3],
    ['refused', 0.15],
    ['disputes_charge', 0.05],
  ]),
  CUSTOMER_ACTION_REQUIRED: new Map([
    ['instrument_fixed', 0.15],
    ['promise_to_pay', 0.25], // "I'll sort the card out and pay"
    ['no_answer', 0.35],
    ['refused', 0.2],
    ['disputes_charge', 0.05],
  ]),
  ABANDONMENT: new Map([
    ['promise_to_pay', 0.3],
    ['no_answer', 0.45],
    ['refused', 0.2],
    ['disputes_charge', 0.05],
  ]),
  // A voice call for a pure infrastructure blip is not really "about" the
  // customer at all -- there is usually nothing for them to fix or promise.
  // Modelled as mostly a wasted or neutral call, occasionally an irritated one.
  TRANSIENT_INFRA: new Map([
    ['no_answer', 0.55],
    ['refused', 0.35],
    ['disputes_charge', 0.1],
  ]),
  AUTH_FAILURE: new Map([
    ['promise_to_pay', 0.3],
    ['no_answer', 0.4],
    ['refused', 0.25],
    ['disputes_charge', 0.05],
  ]),
  // Fraud/blocked-instrument refusals: a human on the phone is far more likely
  // to hear a dispute or a hang-up than any kind of commitment. No
  // `funds_available_now` or `instrument_fixed` here on purpose -- neither is
  // what was ever wrong, and offering them would manufacture a recovery path
  // the class cannot honestly have.
  HARD_DECLINE: new Map([
    ['disputes_charge', 0.35],
    ['refused', 0.3],
    ['no_answer', 0.35],
  ]),
};

/** Draw a customer's voice response, seeded and reproducible. */
export function drawVoiceSignal(recoveryClass: RecoveryClass, rng: Rng): CustomerSignal {
  const dist = DISTRIBUTION[recoveryClass];
  const kind = rng.weighted([...dist.entries()]);
  return { kind } as CustomerSignal;
}
