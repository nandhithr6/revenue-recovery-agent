import type { Action, CustomerProfile, Timestamp } from '../domain/types.js';
import type { HistoryEntry } from '../policies/types.js';
import {
  DEFAULT_COMPLIANCE,
  evaluateCompliance,
  evaluateEscalationCompliance,
  type ComplianceConfig,
} from './compliance.js';
import { DEFAULT_LIMITS, evaluateLimits, type LimitConfig } from './limits.js';

export * from './compliance.js';
export * from './limits.js';

/**
 * The single gate every proposed action passes through.
 *
 * The policy proposes; this disposes. No code path exists by which a policy can
 * execute an action without a verdict from here, which is what makes the
 * separation structural rather than a convention.
 */

export interface GuardrailConfig {
  readonly compliance: ComplianceConfig;
  readonly limits: LimitConfig;
}

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  compliance: DEFAULT_COMPLIANCE,
  limits: DEFAULT_LIMITS,
};

export type Verdict =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'defer';
      readonly notBefore: Timestamp;
      readonly rule: string;
      readonly explanation: string;
    }
  | { readonly kind: 'block'; readonly rule: string; readonly explanation: string };

export interface GateInput {
  readonly action: Action;
  readonly customer: CustomerProfile;
  /** When the action would fire. */
  readonly at: Timestamp;
  readonly caseOpenedAt: Timestamp;
  readonly history: readonly HistoryEntry[];
}

/**
 * Evaluate a proposed action against every guardrail.
 *
 * Order matters. Limits are checked first because they are cheaper and because a
 * case that has exhausted its budget should not even be evaluated for
 * compliance. Within each layer, permission rules precede timing rules: there is
 * no point deferring an action that would never be permitted.
 */
export function gate(input: GateInput, config: GuardrailConfig = DEFAULT_GUARDRAILS): Verdict {
  const { action, customer, at, caseOpenedAt, history } = input;

  // Neither touches the customer nor costs anything, so neither has a
  // guardrail rule that could apply to it. `wait` is handled before reaching
  // here in the engine anyway; this stays defensive and type-correct in case
  // that ever changes.
  if (action.kind === 'stop' || action.kind === 'wait') return { kind: 'allow' };

  const limitVerdict = evaluateLimits(action.kind, at, caseOpenedAt, history, config.limits);
  if (limitVerdict.kind !== 'allow') return limitVerdict;

  if (action.kind === 'contact_customer') {
    if (!action.channel) {
      return {
        kind: 'block',
        rule: 'MALFORMED_ACTION',
        explanation: 'contact_customer proposed without a channel.',
      };
    }
    return evaluateCompliance(action.channel, customer, at, history, config.compliance);
  }

  if (action.kind === 'escalate_human') {
    // A human escalation is a real customer touch (a phone call) -- it must
    // clear the same consent/DND/quiet-hours bar `contact_customer` on
    // `voice` would. See `evaluateEscalationCompliance` for why this is
    // narrower than the full contact-cap logic.
    return evaluateEscalationCompliance(customer, at);
  }

  // Silent retries do not touch the customer at all, so consent and quiet
  // hours do not apply to them. A DND-registered customer can still have
  // their payment retried; we simply may not message or call them about it.
  return { kind: 'allow' };
}
