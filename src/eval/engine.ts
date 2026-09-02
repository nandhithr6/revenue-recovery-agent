import { lookupReason, type RecoveryClass } from '../domain/failure-taxonomy.js';
import {
  DAY,
  type Channel,
  type LossEvent,
  type Paise,
  type Timestamp,
} from '../domain/types.js';
import type { CaseContext, HistoryEntry, Strategy } from '../policies/types.js';
import { NUDGE_EFFECTIVENESS, recoveryOdds } from '../sim/recovery-model.js';
import { Rng } from '../sim/rng.js';
import type { CostModel } from '../sim/scenario.js';

/**
 * Executes a strategy against simulated ground truth and records what happened.
 *
 * The engine is the only component that can see ground truth (recovery odds,
 * whether a customer would respond). Policies see `CaseContext` and nothing more.
 */

/**
 * Hard limits enforced by the engine regardless of policy. These are not the
 * agent's stopping rules; they are the simulation's own backstop so that a
 * pathological policy cannot loop forever.
 */
const MAX_STEPS_PER_CASE = 24;
const MAX_HORIZON_MS = 14 * DAY;

export interface CaseResult {
  readonly eventId: string;
  readonly amountPaise: Paise;
  readonly recovered: boolean;
  readonly recoveredPaise: Paise;
  readonly retries: number;
  readonly contacts: number;
  readonly humanEscalations: number;
  readonly costPaise: Paise;
  readonly history: readonly HistoryEntry[];
  /** Ground-truth class, for reporting only. Never shown to a policy. */
  readonly recoveryClass: RecoveryClass | 'UNKNOWN';
  readonly stoppedReason: string;
}

function classOf(event: LossEvent): RecoveryClass | 'UNKNOWN' {
  if (!event.reasonCode) return 'UNKNOWN';
  return lookupReason(event.reasonCode)?.recoveryClass ?? 'UNKNOWN';
}

export function runCase(
  event: LossEvent,
  strategy: Strategy,
  costs: CostModel,
  rng: Rng,
): CaseResult {
  const recoveryClass = classOf(event);
  const history: HistoryEntry[] = [];
  const channelsUsed: Channel[] = [];

  let now: Timestamp = event.occurredAt;
  let retries = 0;
  let contacts = 0;
  let humanEscalations = 0;
  let costPaise = 0;
  let customerActed = false;
  let recovered = false;
  let stoppedReason = 'engine step limit reached';

  for (let step = 0; step < MAX_STEPS_PER_CASE; step++) {
    const ctx: CaseContext = {
      event,
      now,
      history,
      attemptCount: retries,
      contactCount: contacts,
      channelsUsed,
    };

    const action = strategy.decide(ctx);

    if (action.kind === 'stop') {
      stoppedReason = action.rationale;
      break;
    }

    now += Math.max(0, action.delayMs);
    if (now - event.occurredAt > MAX_HORIZON_MS) {
      stoppedReason = 'recovery horizon exceeded';
      break;
    }

    let succeeded = false;

    switch (action.kind) {
      case 'retry_payment': {
        const elapsed = now - event.occurredAt;
        const odds =
          recoveryClass === 'UNKNOWN'
            ? { probability: 0 }
            : recoveryOdds(recoveryClass, elapsed, retries, customerActed);
        succeeded = rng.chance(odds.probability);
        retries += 1;
        costPaise += costs.retryCostPaise;
        if (succeeded) recovered = true;
        break;
      }

      case 'contact_customer': {
        const channel = action.channel;
        if (!channel) {
          throw new Error('contact_customer action produced without a channel');
        }
        contacts += 1;
        costPaise += costs.contactCostPaise[channel];
        if (!channelsUsed.includes(channel)) channelsUsed.push(channel);

        // A nudge does not recover money directly. It may persuade the customer
        // to fix their instrument, which unlocks a later retry.
        const effectiveness = NUDGE_EFFECTIVENESS[channel] ?? 0;
        if (event.customer.respondsToNudge && rng.chance(effectiveness)) {
          customerActed = true;
          succeeded = true; // the nudge landed, not the money
        }
        break;
      }

      case 'escalate_human': {
        humanEscalations += 1;
        costPaise += costs.humanReviewCostPaise;
        // A human closes the loop more often than any automated channel, but
        // only where the case was recoverable to begin with.
        if (event.customer.respondsToNudge && rng.chance(0.62)) {
          customerActed = true;
          succeeded = true;
        }
        break;
      }
    }

    history.push({ at: now, action, succeeded });

    if (recovered) {
      stoppedReason = 'recovered';
      break;
    }
  }

  return {
    eventId: event.id,
    amountPaise: event.amountPaise,
    recovered,
    recoveredPaise: recovered ? event.amountPaise : 0,
    retries,
    contacts,
    humanEscalations,
    costPaise,
    history,
    recoveryClass,
    stoppedReason,
  };
}

export interface RunResult {
  readonly strategyId: string;
  readonly strategyName: string;
  readonly cases: readonly CaseResult[];
}

export function runCohort(
  events: readonly LossEvent[],
  strategy: Strategy,
  costs: CostModel,
  seed: number,
): RunResult {
  // Each strategy gets an identically seeded RNG, so differences in outcome are
  // caused by decisions, not by luck.
  const rng = new Rng(seed);
  const cases = events.map((e) => runCase(e, strategy, costs, rng));
  return { strategyId: strategy.id, strategyName: strategy.name, cases };
}
