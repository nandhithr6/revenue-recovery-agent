import { lookupReason, type RecoveryClass } from '../domain/failure-taxonomy.js';
import { DAY, HOUR, type Action, type Channel, type Paise, type Timestamp } from '../domain/types.js';
import { SPAM_POINTS } from '../guardrails/compliance.js';
import type { CostModel } from '../sim/scenario.js';
import {
  HUMAN_ESCALATION_FLOOR_PAISE,
  PLAYBOOKS,
  SPAM_POINT_PRICE_PAISE,
  worthContacting,
  type Playbook,
} from './playbook.js';
import { DEFAULT_LIMITS } from '../guardrails/limits.js';
import { LOSS_PROFILES, type LossProfile } from './loss-profiles.js';
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

/**
 * Guardrail rules that end a case rather than merely refusing one action.
 * Once one of these has fired, every further proposal is refused identically,
 * so the agent stops instead of filling the ledger with the same block.
 */
const TERMINAL_RULES: ReadonlySet<string> = new Set([
  'CASE_AGE_LIMIT',
  'KILL_SWITCH',
  'MAX_HUMAN_ESCALATIONS',
]);

/** Never schedule an attempt the case-age limit would refuse on arrival. */
const MAX_USEFUL_CASE_AGE_MS = DEFAULT_LIMITS.maxCaseAgeMs;

/**
 * Human-readable delay. Hours are the natural unit for most of this agent's
 * schedule, but rounding two minutes to '+0.0h' makes a fast abandonment retry
 * look like an immediate one, which is the opposite of the point.
 */
function formatDelay(ms: number): string {
  if (ms < HOUR) return `${Math.round(ms / 60_000)}m`;
  if (ms < DAY) return `${(ms / HOUR).toFixed(1)}h`;
  return `${(ms / DAY).toFixed(1)}d`;
}

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
 *
 * The ladder is the recovery class's, extended by the loss type's: a receivable
 * chase needs channels a card retry never would.
 */
function nextChannel(
  playbook: Playbook,
  profile: LossProfile,
  ctx: CaseContext,
  blocked: Set<Channel>,
): Channel | undefined {
  const ladder = [
    ...playbook.channelLadder,
    ...profile.extraChannels.filter((c) => !playbook.channelLadder.includes(c)),
  ];
  return ladder.find(
    (c) => ctx.event.customer.consent[c] && !ctx.channelsUsed.includes(c) && !blocked.has(c),
  );
}

/**
 * Promise-to-pay tracking, for receivables only.
 *
 * When an accounts-payable contact lands, we treat it as a commitment to pay
 * within the promise window. Chasing them again inside that window is both
 * rude and counterproductive; chasing them the moment it lapses is the entire
 * job of a receivables collector.
 */
interface PromiseState {
  readonly madeAt: Timestamp;
  readonly dueBy: Timestamp;
  readonly broken: boolean;
}

function promiseState(
  profile: LossProfile,
  history: readonly HistoryEntry[],
  now: Timestamp,
): PromiseState | undefined {
  if (!profile.tracksPromiseToPay) return undefined;

  const landed = history.filter(
    (h) => h.action.kind === 'contact_customer' && h.blockedBy === undefined && h.succeeded,
  );
  const last = landed.at(-1);
  if (!last) return undefined;

  const dueBy = last.at + profile.promiseWindowMs;
  return { madeAt: last.at, dueBy, broken: now >= dueBy };
}

function classify(ctx: CaseContext): RecoveryClass | undefined {
  if (!ctx.event.reasonCode) return undefined;
  return lookupReason(ctx.event.reasonCode)?.recoveryClass;
}

/**
 * @param annoyancePricePaise what one point of customer annoyance is worth to
 *   this agent. Defaults to the shipped figure. Parameterised so the
 *   sensitivity sweep can ask the fair question: at a different price, does the
 *   agent still win once it is allowed to ADAPT to that price, rather than being
 *   scored against a price it was never told about?
 */
export function createRulesAgent(
  costs: CostModel,
  annoyancePricePaise: Paise = SPAM_POINT_PRICE_PAISE,
): Strategy {
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
      const profile = LOSS_PROFILES[ctx.event.lossType];
      const { amountPaise } = ctx.event;
      const elapsed = ctx.now - ctx.event.occurredAt;
      const blockedChans = blockedChannels(ctx.history);
      const rules = blockedRules(ctx.history);

      // Some guardrail rules close a case for good. Continuing to propose work
      // after one has fired is exactly the loop fixed dunning falls into, and
      // the agent should not repeat it: it burns steps and fills the ledger with
      // identical refusals.
      const terminal = [...TERMINAL_RULES].filter((r) => rules.has(r));
      if (terminal.length > 0) {
        return STOP(`case closed by ${terminal.join(', ')}; no further action is permitted`);
      }

      // The loss type decides what is even permitted. You cannot re-attempt a
      // charge nobody authorised, and you cannot "retry" an invoice.
      const scaled = playbook.retrySchedule.map((d) => d * profile.retryDelayScale);

      // Precedence matters here, and getting it backwards was a real bug.
      //
      // An empty class schedule is not "no opinion", it is the strongest opinion
      // the playbook can express: retrying this can NEVER work. A fraud-flagged
      // card stays fraud-flagged whether the loss is a one-off charge or a
      // subscription. So a loss type may extend a schedule that exists; it may
      // not conjure one that does not.
      //
      // Without this guard, `extraRetries` on the mandate profile fell back to a
      // one-day anchor and manufactured attempts against hard declines, which is
      // exactly the behaviour the whole project criticises.
      const canRetry = profile.canRetryCharge && scaled.length > 0;
      const lastScheduled = scaled.at(-1) ?? DAY;

      const retrySchedule = canRetry
        ? [
            ...scaled,
            // A standing mandate earns extra attempts, spaced out rather than
            // multiplied: compounding the scale pushed the last attempt past
            // three weeks, well beyond the case-age limit that would refuse it.
            ...Array.from(
              { length: profile.extraRetries },
              (_, i) => lastScheduled + (i + 1) * 1.5 * DAY,
            ),
          ].filter((d) => d < MAX_USEFUL_CASE_AGE_MS)
        : [];

      // ---- 1. Stop classes. -------------------------------------------
      //
      // Doing nothing is an active decision here, not an omission. Retrying a
      // fraud-flagged instrument cannot succeed and can damage the merchant's
      // authorisation rate with the issuer.
      if (retrySchedule.length === 0 && playbook.channelLadder.length === 0 && profile.extraChannels.length === 0) {
        if (
          amountPaise >= Math.min(HUMAN_ESCALATION_FLOOR_PAISE, profile.humanFloorPaise) &&
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

      // ---- 2. Promise to pay, for receivables. -------------------------
      //
      // An accounts-payable contact that landed is a commitment, not a
      // recovery. Chasing inside the promise window is rude and ineffective;
      // chasing the moment it lapses is the whole job.
      //
      // This used to return STOP, which does not mean "pause" -- it means
      // "this case is finished," and it ended the case on the spot instead of
      // coming back once the window lapsed. A real defect, found by comparing
      // one case against fixed-dunning: fixed-dunning does not know what a
      // promise is, so it kept blindly retrying and recovered money this
      // agent had already earned the right to chase, then threw away by
      // never coming back for it. `wait` fixes that: pause exactly until the
      // promise is due, then this branch is skipped and the chase proceeds.
      const promise = promiseState(profile, ctx.history, ctx.now);
      if (promise && !promise.broken) {
        return {
          kind: 'wait',
          delayMs: Math.max(0, promise.dueBy - ctx.now),
          rationale: `receivable: commitment to pay recorded, honouring the ${profile.promiseWindowMs / DAY}-day window before chasing again`,
        };
      }

      // ---- 3. A nudge landed: strike while the instrument is fixed. -----
      const landed = nudgeLandedAt(ctx.history);
      if (profile.canRetryCharge && landed !== undefined && !retriedSince(ctx.history, landed)) {
        return {
          kind: 'retry_payment',
          delayMs: 5 * 60_000,
          rationale:
            'customer acted on our nudge, so the instrument should now work; retrying immediately',
        };
      }

      // ---- 4. Scheduled retries, if this class and loss type allow any. --
      //
      // The schedule is expressed as offsets from the ORIGINAL failure, so the
      // agent targets an absolute moment rather than drifting later each time
      // a guardrail defers it.
      const retriesDone = executed(ctx.history, 'retry_payment').length;
      const retryBudgetLeft =
        retriesDone < retrySchedule.length && !rules.has('MAX_RETRIES');

      if (retryBudgetLeft && !playbook.nudgeIsThePath) {
        const target = retrySchedule[retriesDone]!;
        const delayMs = Math.max(0, target - elapsed);
        return {
          kind: 'retry_payment',
          delayMs,
          rationale: `${recoveryClass} / ${profile.label}: retry ${retriesDone + 1} of ${retrySchedule.length} at +${formatDelay(target)} after the failure -- ${playbook.reasoning}`,
        };
      }

      // ---- 5. Escalate to a customer, if the value justifies it. --------
      const channel = nextChannel(playbook, profile, ctx, blockedChans);
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
            annoyancePricePaise,
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
        amountPaise >= profile.humanFloorPaise &&
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
      return STOP(`${recoveryClass} / ${profile.label}: ${why}`);
    },
  };
}
