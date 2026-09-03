import { lookupReason } from '../domain/failure-taxonomy.js';
import {
  HOUR,
  type Action,
  type CandidateSummary,
  type Channel,
  type CustomerSignal,
  type Paise,
  type Timestamp,
} from '../domain/types.js';
import { assess, type CaseAssessment } from '../policies/assessment.js';
import type { CaseContext } from '../policies/types.js';

export type { CandidateSummary };

/**
 * Decision traces.
 *
 * The scoreboard asks to be believed. A trace asks to be checked: for every
 * decision it records the exact inputs the policy was given, the action it
 * returned with its own words for why, and the guardrail verdict that followed.
 *
 * That is the difference between claiming an agent works and letting someone
 * verify it. Anyone can pick a case and follow input -> rule -> output.
 *
 * Tracing is opt-in. `runCase` takes no trace by default, so the robustness run
 * (which executes tens of thousands of cases) allocates nothing.
 */

/**
 * Exactly what the policy could see when it decided -- a projection of
 * `CaseContext`, nothing added.
 *
 * `derivedRecoveryClass` is included because it is not privileged: the policy
 * computes it itself from the public Razorpay reason code via the taxonomy. The
 * simulator's ground-truth recovery odds are NOT here, and must never be.
 */
export interface AgentView {
  readonly reasonCode: string | undefined;
  /** Derived by the policy from the reason code, not handed to it. */
  readonly derivedRecoveryClass: string;
  readonly lossType: string;
  readonly method: string;
  readonly amountPaise: Paise;
  readonly hoursSinceFailure: number;
  readonly retriesSoFar: number;
  readonly contactsSoFar: number;
  readonly channelsUsed: readonly Channel[];
  readonly consentedChannels: readonly Channel[];
  readonly dndRegistered: boolean;
  /** Guardrail rules already hit on this case, which the policy can read. */
  readonly rulesAlreadyHit: readonly string[];
  /**
   * `CaseAssessment` recomputed independently for display -- same
   * deterministic function every strategy that uses it calls, not something
   * only `agent-adaptive` sees. Shown here regardless of which strategy
   * produced this step, so a reader can compare "what the case actually was"
   * against what a non-adaptive strategy did with it.
   */
  readonly assessment: CaseAssessment;
}

export interface TraceVerdict {
  readonly kind: 'allow' | 'defer' | 'block';
  readonly rule?: string;
  readonly explanation?: string;
  readonly notBefore?: Timestamp;
}

export interface TraceStep {
  readonly step: number;
  readonly at: Timestamp;
  readonly seen: AgentView;
  readonly decided: {
    readonly kind: string;
    readonly channel?: Channel;
    readonly delayMs: number;
    /** The policy's own words. Never paraphrased. */
    readonly rationale: string;
  };
  readonly verdict: TraceVerdict;
  readonly outcome: 'executed' | 'deferred' | 'blocked' | 'stopped';
  readonly succeeded?: boolean;
  readonly costPaise: Paise;
  readonly spamPoints: number;
  /** Set only when this step was a voice contact that connected. */
  readonly signal?: CustomerSignal;
  /**
   * The full priced candidate comparison behind this decision -- present
   * only when the engine was given a `candidateHook` (see `runCase`) and
   * that hook actually priced something (absent for a short-circuit like a
   * terminal rule or a voice-signal stop, where there was nothing to
   * compare; see `policies/adaptive-agent.ts:Explanation`).
   */
  readonly candidates?: readonly CandidateSummary[];
}

export interface CaseTrace {
  readonly strategyId: string;
  readonly steps: readonly TraceStep[];
  readonly recovered: boolean;
  readonly recoveredPaise: Paise;
  readonly costPaise: Paise;
  readonly spamPoints: number;
  readonly stoppedReason: string;
}

/** Snapshot the policy's inputs. Called before `decide`, never after. */
export function captureView(ctx: CaseContext): AgentView {
  const { event } = ctx;
  const consented = (['email', 'sms', 'whatsapp', 'voice'] as const).filter(
    (c) => event.customer.consent[c],
  );
  const rules = new Set<string>();
  for (const h of ctx.history) if (h.blockedBy) rules.add(h.blockedBy);

  return {
    reasonCode: event.reasonCode,
    derivedRecoveryClass: event.reasonCode
      ? (lookupReason(event.reasonCode)?.recoveryClass ?? 'UNKNOWN')
      : 'UNKNOWN',
    lossType: event.lossType,
    method: event.method,
    amountPaise: event.amountPaise,
    hoursSinceFailure: Number(((ctx.now - event.occurredAt) / HOUR).toFixed(2)),
    retriesSoFar: ctx.attemptCount,
    contactsSoFar: ctx.contactCount,
    channelsUsed: [...ctx.channelsUsed],
    consentedChannels: consented,
    dndRegistered: event.customer.dndRegistered,
    rulesAlreadyHit: [...rules],
    assessment: assess(ctx),
  };
}

/** Flatten an `Action` for the trace, keeping the rationale verbatim. */
export function captureAction(action: Action): TraceStep['decided'] {
  return {
    kind: action.kind,
    ...(action.channel ? { channel: action.channel } : {}),
    delayMs: action.delayMs,
    rationale: action.rationale,
  };
}

/** Collects steps for one case. Passed into `runCase` to enable tracing. */
export class TraceSink {
  private readonly steps: TraceStep[] = [];

  push(step: Omit<TraceStep, 'step'>): void {
    this.steps.push({ ...step, step: this.steps.length });
  }

  drain(): readonly TraceStep[] {
    return this.steps;
  }
}
