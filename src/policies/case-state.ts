import type { Channel, CustomerSignal, Timestamp } from '../domain/types.js';
import { assess, assessmentChanged, type CaseAssessment, type UnknownReasonInterpreter } from './assessment.js';
import type { LossProfile } from './loss-profiles.js';
import type { CaseContext, HistoryEntry } from './types.js';

/**
 * Everything `agent-adaptive` derives from a case's own history before
 * pricing candidates -- named and computed in one place instead of scattered
 * across several small helper functions re-scanning `ctx.history` on every
 * call (which is exactly what this file replaces).
 *
 * This is PER-CASE state, derived fresh from `ctx` on every `decide()` call.
 * It is not cross-case memory: nothing here survives between cases or
 * between cohort runs, `Strategy.decide(ctx) => Action` stays a pure function
 * of its input, and the 250-cohort robustness harness needs no changes --
 * see docs/adr/0008-why-not-online-learning-yet.md, which this does not
 * revisit or weaken.
 */
export interface CaseState {
  readonly attemptsSoFar: number;
  readonly contactsSoFar: number;
  readonly channelsUsed: readonly Channel[];
  readonly blockedRules: ReadonlySet<string>;
  readonly blockedChannels: ReadonlySet<Channel>;
  /** The most recent voice signal on this case, if a voice contact has landed. */
  readonly lastSignal: CustomerSignal | undefined;
  /** When that signal's call happened -- needed to price a promise-to-pay window from it. */
  readonly lastSignalAt: Timestamp | undefined;
  readonly customerActed: boolean;
  readonly promise: { readonly dueBy: Timestamp; readonly broken: boolean } | undefined;
  readonly assessment: CaseAssessment;
  /** True when this step's assessment differs from last step's -- new evidence arrived. */
  readonly replanned: boolean;
}

function executed(history: readonly HistoryEntry[], kind: string): readonly HistoryEntry[] {
  return history.filter((h) => h.action.kind === kind && h.blockedBy === undefined);
}

function blockedRuleSet(history: readonly HistoryEntry[]): ReadonlySet<string> {
  const rules = new Set<string>();
  for (const h of history) if (h.blockedBy) rules.add(h.blockedBy);
  return rules;
}

function blockedChannelSet(history: readonly HistoryEntry[]): ReadonlySet<Channel> {
  const blocked = new Set<Channel>();
  for (const h of history) {
    if (h.blockedBy && h.action.kind === 'contact_customer' && h.action.channel) {
      blocked.add(h.action.channel);
    }
  }
  return blocked;
}

function lastLandedContactAt(history: readonly HistoryEntry[]): Timestamp | undefined {
  const landed = history.find(
    (h) => h.action.kind === 'contact_customer' && h.blockedBy === undefined && h.succeeded,
  );
  return landed?.at;
}

function retriedSince(history: readonly HistoryEntry[], since: Timestamp): boolean {
  return executed(history, 'retry_payment').some((h) => h.at >= since);
}

function lastVoiceSignal(
  history: readonly HistoryEntry[],
): { signal: CustomerSignal; at: Timestamp } | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i]!;
    if (h.action.kind === 'contact_customer' && h.action.channel === 'voice' && h.signal) {
      return { signal: h.signal, at: h.at };
    }
  }
  return undefined;
}

/**
 * What the assessment would have been one step ago, so `deriveState` can
 * detect a change without any caller having to thread state across calls.
 * Pure recomputation from a trimmed history -- `assess()` doesn't read
 * `ctx.now`, so nothing is lost by not reconstructing the exact prior clock.
 * Explicitly NOT cross-case memory: this only ever looks at THIS case's own
 * history, one entry shorter.
 */
function priorAssessmentOf(ctx: CaseContext, interpretUnknown?: UnknownReasonInterpreter): CaseAssessment | undefined {
  if (ctx.history.length === 0) return undefined;
  const trimmed = ctx.history.slice(0, -1);
  const priorCtx: CaseContext = {
    ...ctx,
    history: trimmed,
    attemptCount: trimmed.filter((h) => h.action.kind === 'retry_payment' && h.blockedBy === undefined).length,
    contactCount: trimmed.filter((h) => h.action.kind === 'contact_customer' && h.blockedBy === undefined).length,
  };
  return assess(priorCtx, interpretUnknown);
}

export function deriveState(
  ctx: CaseContext,
  profile: LossProfile,
  priorAssessment?: CaseAssessment,
  interpretUnknown?: UnknownReasonInterpreter,
): CaseState {
  const { history } = ctx;
  const landedAt = lastLandedContactAt(history);
  const customerActed = landedAt !== undefined && !retriedSince(history, landedAt);
  const prior = priorAssessment ?? priorAssessmentOf(ctx, interpretUnknown);

  let promise: CaseState['promise'];
  if (profile.tracksPromiseToPay) {
    const lastLanded = history
      .filter((h) => h.action.kind === 'contact_customer' && h.blockedBy === undefined && h.succeeded)
      .at(-1);
    if (lastLanded) {
      const dueBy = lastLanded.at + profile.promiseWindowMs;
      promise = { dueBy, broken: ctx.now >= dueBy };
    }
  }

  const assessment = assess(ctx, interpretUnknown);
  const voice = lastVoiceSignal(history);

  return {
    attemptsSoFar: executed(history, 'retry_payment').length,
    contactsSoFar: executed(history, 'contact_customer').length,
    channelsUsed: ctx.channelsUsed,
    blockedRules: blockedRuleSet(history),
    blockedChannels: blockedChannelSet(history),
    lastSignal: voice?.signal,
    lastSignalAt: voice?.at,
    customerActed,
    promise,
    assessment,
    replanned: assessmentChanged(prior, assessment),
  };
}
