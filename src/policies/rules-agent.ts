import { lookupReason, type RecoveryClass } from '../domain/failure-taxonomy.js';
import type { Action, Channel, Timestamp } from '../domain/types.js';
import { SPAM_POINTS } from '../guardrails/compliance.js';
import type { CostModel } from '../sim/scenario.js';
import {
  HUMAN_ESCALATION_FLOOR_PAISE,
  PLAYBOOKS,
  worthContacting,
  type Playbook,
} from './playbook.js';
import { STOP, type CaseContext, type HistoryEntry, type Strategy } from './types.js';

/**
 * The reason-aware recovery agent.
 *
 * Its whole thesis is that the baselines are reason-BLIND. Naive retry is fast
 * and therefore good at abandonment but hopeless at outages; fixed dunning is
 * patient and therefore good at outages but too slow for abandonment. Neither
 * can be both, because neither looks at why the payment failed.
 *
 * This agent reads Razorpay's failure reason, maps it to a recovery class, and
 * runs the playbook for that class. Concretely it does four things the
 * baselines cannot:
 *
 *   1. Spends ZERO retries on classes where retries provably cannot work
 *      (expired cards, fraud flags). The baselines burn ~150 attempts there.
 *   2. Retries FAST on abandonment and SLOWLY on insufficient funds, rather
 *      than picking one tempo for everything.
 *   3. Reads its own history and routes around guardrail blocks instead of
 *      re-proposing an action that was just refused.
 *   4. Weighs expected value against cost, so it will not spend Rs 15 on a
 *      voice call to chase Rs 40.
 *
 * It never reads the simulator's ground truth. See the integrity note in
 * playbook.ts.
 */

/** Executed (not blocked) entries of a given kind. */
function executed(history: readonly HistoryEntry[], kind: string): HistoryEntry[] {
  return history.filter((h) => h.action.kind === kind && h.blockedBy === undefined);
}

/**
 * Guardrail rules this case has already run into, so the agent can stop
 * proposing things that will be refused again.
 */
function blockedRules(history: readonly HistoryEntry[]): Set<string> {
  const rules = new Set<string>();
  for (const h of history) if (h.blockedBy) rules.add(h.blockedBy);
  return rules;
}

/** Channels that were proposed and refused. Trying them again wastes a step. */
function blockedChannels(history: readonly HistoryEntry[]): Set<Channel> {
  const blocked = new Set<Channel>();
  for (const h of history) {
    if (h.blockedBy && h.action.kind === 'contact_customer' && h.action.channel) {
      blocked.add(h.action.channel);
    }
  }
  return blocked;
}

/**
 * When a nudge lands, the customer has fixed their instrument. In production
 * this arrives as a webhook (card updated, mandate re-authorised); here it is
 * the `succeeded` flag on an executed contact. Either way it is an observable
 * signal, not privileged knowledge.
 */
function nudgeLandedAt(history: readonly HistoryEntry[]): Timestamp | undefined {
  const landed = history.find(
    (h) => h.action.kind === 'contact_customer' && h.blockedBy === undefined && h.succeeded,
  );
  return landed?.at;
}

function retriedSince(history: readonly HistoryEntry[], since: Timestamp): boolean {
  return executed(history, 'retry_payment').some((h) => h.at >= since);
}

/**
 * Next channel on the ladder that is consented to, not already used, and not
 * already blocked.
 */
function nextChannel(
  playbook: Playbook,
  ctx: CaseContext,
  blocked: Set<Channel>,
): Channel | undefined {
  return playbook.channelLadder.find(
    (c) => ctx.event.customer.consent[c] && !ctx.channelsUsed.includes(c) && !blocked.has(c),
  );
}

function classify(ctx: CaseContext): RecoveryClass | undefined {
  if (!ctx.event.reasonCode) return undefined;
  return lookupReason(ctx.event.reasonCode)?.recoveryClass;
}

export function createRulesAgent(costs: CostModel): Strategy {
  return {
    id: 'agent-rules',
    name: 'Reason-aware agent',
    description:
      'Classifies each failure by Razorpay reason code and runs a per-class playbook: fast on abandonment, patient on funds, zero retries on hopeless classes, and value-weighted escalation.',

    decide(ctx: CaseContext): Action {
      const recoveryClass = classify(ctx);
      if (!recoveryClass) {
        return STOP('unrecognised failure reason; refusing to act blindly');
      }

      const playbook = PLAYBOOKS[recoveryClass];
      const { amountPaise } = ctx.event;
      const elapsed = ctx.now - ctx.event.occurredAt;
      const blockedChans = blockedChannels(ctx.history);
      const rules = blockedRules(ctx.history);

      // ---- 1. Stop classes. -------------------------------------------
      //
      // Doing nothing is an active decision here, not an omission. Retrying a
      // fraud-flagged instrument cannot succeed and can damage the merchant's
      // authorisation rate with the issuer.
      if (playbook.retrySchedule.length === 0 && playbook.channelLadder.length === 0) {
        if (
          amountPaise >= HUMAN_ESCALATION_FLOOR_PAISE &&
          ctx.history.every((h) => h.action.kind !== 'escalate_human')
        ) {
          return {
            kind: 'escalate_human',
            delayMs: 0,
            rationale: `${recoveryClass}: unrecoverable automatically, but the amount warrants a human risk review`,
          };
        }
        return STOP(`${recoveryClass}: ${playbook.reasoning}`);
      }

      // ---- 2. A nudge landed: strike while the instrument is fixed. -----
      const landed = nudgeLandedAt(ctx.history);
      if (landed !== undefined && !retriedSince(ctx.history, landed)) {
        return {
          kind: 'retry_payment',
          delayMs: 5 * 60_000,
          rationale:
            'customer acted on our nudge, so the instrument should now work; retrying immediately',
        };
      }

      // ---- 3. Scheduled retries, if this class has any. -----------------
      //
      // The schedule is expressed as offsets from the ORIGINAL failure, so the
      // agent targets an absolute moment rather than drifting later each time
      // a guardrail defers it.
      const retriesDone = executed(ctx.history, 'retry_payment').length;
      const retryBudgetLeft =
        retriesDone < playbook.retrySchedule.length && !rules.has('MAX_RETRIES');

      if (retryBudgetLeft && !playbook.nudgeIsThePath) {
        const target = playbook.retrySchedule[retriesDone]!;
        const delayMs = Math.max(0, target - elapsed);
        return {
          kind: 'retry_payment',
          delayMs,
          rationale: `${recoveryClass}: retry ${retriesDone + 1} of ${playbook.retrySchedule.length} at +${(target / 3_600_000).toFixed(1)}h -- ${playbook.reasoning}`,
        };
      }

      // ---- 4. Escalate to a customer, if the value justifies it. --------
      const channel = nextChannel(playbook, ctx, blockedChans);
      if (channel && !rules.has('MAX_CONTACTS') && !rules.has('WEEKLY_CONTACT_CAP')) {
        const cost = costs.contactCostPaise[channel];
        // Counting annoyance as a real cost is what keeps the agent quiet on
        // small cases: a Rs 400 cart earns an email, not a WhatsApp message.
        if (
          worthContacting(
            amountPaise,
            playbook.believedPeakOdds,
            channel,
            cost,
            SPAM_POINTS[channel],
          )
        ) {
          // On nudge-is-the-path classes, reach out immediately: every hour of
          // delay is an hour the customer has forgotten they wanted this.
          // Elsewhere, only after the retry schedule has had its chance.
          const delayMs = playbook.nudgeIsThePath ? 0 : 30 * 60_000;
          return {
            kind: 'contact_customer',
            channel,
            delayMs,
            rationale: playbook.nudgeIsThePath
              ? `${recoveryClass}: no retry can succeed until the customer fixes the instrument, so nudging on ${channel}`
              : `${recoveryClass}: retries exhausted, prompting on ${channel}`,
          };
        }
        return STOP(
          `${recoveryClass}: expected gain on Rs ${(amountPaise / 100).toFixed(0)} does not justify the cost and intrusion of ${channel} outreach`,
        );
      }

      // ---- 5. Human, only for cases large enough to deserve one. --------
      if (
        amountPaise >= HUMAN_ESCALATION_FLOOR_PAISE &&
        ctx.history.every((h) => h.action.kind !== 'escalate_human') &&
        !rules.has('MAX_HUMAN_ESCALATIONS')
      ) {
        return {
          kind: 'escalate_human',
          delayMs: 60 * 60_000,
          rationale: `automated recovery exhausted on a high-value case; handing to a human`,
        };
      }

      // ---- 6. Stop, and say why. ---------------------------------------
      const why = rules.size > 0 ? `guardrails exhausted (${[...rules].join(', ')})` : 'playbook exhausted';
      return STOP(`${recoveryClass}: ${why}`);
    },
  };
}
