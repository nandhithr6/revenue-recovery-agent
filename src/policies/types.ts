import type { Action, Channel, CustomerSignal, LossEvent, Timestamp } from '../domain/types.js';

/** One thing the engine did, and what came of it. */
export interface HistoryEntry {
  readonly at: Timestamp;
  readonly action: Action;
  readonly succeeded: boolean;
  /** Set when a guardrail blocked the action; it then did not execute. */
  readonly blockedBy?: string;
  /**
   * Set only for a voice contact that connected: what the customer actually
   * said, structured. Every other channel resolves to `succeeded` alone --
   * this is strictly additive, so nothing that reads `succeeded` needs to
   * change to keep working.
   */
  readonly signal?: CustomerSignal;
}

/**
 * Everything a policy is allowed to see when deciding.
 *
 * Deliberately excludes ground truth: no recovery class, no customer
 * responsiveness, no odds. A policy must infer all of that from the failure
 * reason, exactly as it would in production.
 */
export interface CaseContext {
  readonly event: LossEvent;
  readonly now: Timestamp;
  readonly history: readonly HistoryEntry[];
  /** Retry attempts executed so far. */
  readonly attemptCount: number;
  /** Outbound contacts executed so far. */
  readonly contactCount: number;
  /** Channels already used, so a policy can climb the ladder. */
  readonly channelsUsed: readonly Channel[];
}

/**
 * A recovery policy: given the state of a case, decide the single next action.
 *
 * Called repeatedly until it returns `stop` or the engine's own limits bite.
 * Returning an action is a *proposal*; guardrails may still refuse it.
 */
export interface Strategy {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  decide(ctx: CaseContext): Action;
}

/** Convenience for policies that never act. */
export const STOP = (rationale: string): Action => ({
  kind: 'stop',
  delayMs: 0,
  rationale,
});
