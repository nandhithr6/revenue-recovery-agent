import { DAY, HOUR, type Timestamp } from '../domain/types.js';
import type { HistoryEntry } from '../policies/types.js';

/**
 * Stopping rules: how hard the agent is allowed to push on one case.
 *
 * Razorpay's brief names stopping rules explicitly. The point is not that a
 * well-behaved policy chooses to stop; it is that a MISBEHAVING policy cannot
 * continue. These limits are evaluated by the engine, not by the policy, so an
 * LLM that decides to retry forty times simply does not get to.
 */

export interface LimitConfig {
  /** Hard ceiling on payment re-attempts for one loss event. */
  readonly maxRetries: number;
  /** Minimum gap between two payment re-attempts. */
  readonly minRetryGapMs: number;
  /** Hard ceiling on outbound contacts for one loss event. */
  readonly maxContacts: number;
  /** Hard ceiling on human escalations for one loss event. */
  readonly maxHumanEscalations: number;
  /** Abandon the case entirely after this long. */
  readonly maxCaseAgeMs: number;
  /**
   * Global kill switch. When true, every action is refused. Exists so an
   * operator can halt all recovery activity without redeploying.
   */
  readonly killSwitch: boolean;
}

export const DEFAULT_LIMITS: LimitConfig = {
  maxRetries: 5,
  minRetryGapMs: 15 * 60_000,
  maxContacts: 4,
  maxHumanEscalations: 1,
  maxCaseAgeMs: 10 * DAY,
  killSwitch: false,
};

export type LimitVerdict =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'defer';
      readonly notBefore: Timestamp;
      readonly rule: string;
      readonly explanation: string;
    }
  | { readonly kind: 'block'; readonly rule: string; readonly explanation: string };

function executed(history: readonly HistoryEntry[], kind: string): HistoryEntry[] {
  return history.filter((h) => h.action.kind === kind && h.blockedBy === undefined);
}

export function evaluateLimits(
  actionKind: 'retry_payment' | 'contact_customer' | 'escalate_human',
  at: Timestamp,
  caseOpenedAt: Timestamp,
  history: readonly HistoryEntry[],
  config: LimitConfig = DEFAULT_LIMITS,
): LimitVerdict {
  if (config.killSwitch) {
    return {
      kind: 'block',
      rule: 'KILL_SWITCH',
      explanation: 'Global kill switch is engaged; all recovery activity is halted.',
    };
  }

  if (at - caseOpenedAt > config.maxCaseAgeMs) {
    return {
      kind: 'block',
      rule: 'CASE_AGE_LIMIT',
      explanation: `Case is older than ${config.maxCaseAgeMs / DAY} days. Further recovery effort is not justified.`,
    };
  }

  switch (actionKind) {
    case 'retry_payment': {
      const retries = executed(history, 'retry_payment');
      if (retries.length >= config.maxRetries) {
        return {
          kind: 'block',
          rule: 'MAX_RETRIES',
          explanation: `Already attempted ${retries.length} retries (cap ${config.maxRetries}). Repeated authorisation attempts risk tripping issuer controls.`,
        };
      }
      const last = retries.at(-1);
      if (last && at - last.at < config.minRetryGapMs) {
        return {
          kind: 'defer',
          notBefore: last.at + config.minRetryGapMs,
          rule: 'RETRY_COOLDOWN',
          explanation: `Last retry was ${((at - last.at) / 60_000).toFixed(0)}m ago; minimum gap is ${config.minRetryGapMs / 60_000}m.`,
        };
      }
      return { kind: 'allow' };
    }

    case 'contact_customer': {
      const contacts = executed(history, 'contact_customer');
      if (contacts.length >= config.maxContacts) {
        return {
          kind: 'block',
          rule: 'MAX_CONTACTS',
          explanation: `Already contacted ${contacts.length} times on this case (cap ${config.maxContacts}).`,
        };
      }
      return { kind: 'allow' };
    }

    case 'escalate_human': {
      const escalations = executed(history, 'escalate_human');
      if (escalations.length >= config.maxHumanEscalations) {
        return {
          kind: 'block',
          rule: 'MAX_HUMAN_ESCALATIONS',
          explanation: `Case has already been escalated to a human ${escalations.length} time(s).`,
        };
      }
      return { kind: 'allow' };
    }
  }
}

/** Longest a case may sit deferred before the engine gives up waiting. */
export const MAX_DEFERRALS_PER_ACTION = 4;
export const MAX_DEFERRAL_SPAN_MS = 3 * DAY;

export { HOUR };
