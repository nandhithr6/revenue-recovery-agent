import { FAILURE_REASONS, lookupReason, type RecoveryClass } from '../domain/failure-taxonomy.js';
import type { CaseContext, HistoryEntry } from './types.js';

/**
 * `CaseAssessment` -- what the adaptive agent believes about a case BEFORE it
 * prices any candidate action.
 *
 * This replaces the old one-line gate in `adaptive-agent.ts`
 * (`classify(ctx) ?? STOP(...)`), which had exactly two states: fully known,
 * or a hard stop. Real intake is not binary -- a reason code can be known but
 * arrive in a context the model has no experience with; a code can be unknown
 * but still say something (via its own vocabulary, or a matched sibling)
 * about what kind of problem it probably is. `CaseAssessment` names the
 * states in between and, critically, is what candidate generation branches on
 * instead of the raw recovery class -- see `action-registry.ts`.
 */

export type Confidence = 'high' | 'medium' | 'low';
export type AssessmentStatus = 'known' | 'inferred' | 'unknown';

export interface CaseAssessment {
  readonly status: AssessmentStatus;
  readonly recoveryClass: RecoveryClass | undefined;
  readonly confidence: Confidence;
  /** Why this confidence -- short, human-readable, shown verbatim in the UI. */
  readonly evidence: readonly string[];
  /** Irregularities detected in the case's own context or history. */
  readonly anomalies: readonly string[];
}

export interface FallbackInterpretation {
  readonly recoveryClass: RecoveryClass | null;
  readonly confidence: 'low' | 'medium';
  readonly evidence: readonly string[];
}

/**
 * An external interpreter for a reason code the taxonomy doesn't recognise.
 * `assess()` accepts one optionally; `deterministicFallback` below is always
 * available and used when none is supplied or it returns nothing. This is the
 * ONLY seam an LLM-backed interpreter (see `llm/unknown-error.ts`) plugs
 * into -- it can influence `evidence` and a MEDIUM-capped `recoveryClass`
 * guess, nothing else. It has no path to an `Action`, a guardrail verdict, or
 * execution.
 */
export type UnknownReasonInterpreter = (input: {
  readonly reasonCode: string;
}) => FallbackInterpretation | undefined;

// --------------------------------------------------------------------------
// Part B: deterministic fallback for an unrecognised reason code.
//
// This is fuzzy STRING matching, nothing more -- token overlap against the 21
// documented codes' own vocabulary, plus a consistency check against the
// bank/gateway/customer/network `source` those codes carry. It is not
// learning, not embeddings, not semantic similarity in any statistical sense;
// calling it that would be exactly the kind of overclaim this project has
// spent effort NOT making elsewhere. What it buys: a code like
// "upi_collect_request_lapsed" shares enough vocabulary with the documented
// "payment_collect_request_expired" (ABANDONMENT) to be worth a MEDIUM-
// confidence guess instead of an immediate shrug -- and a code that shares
// nothing with anything documented gets exactly that shrug, honestly.
// --------------------------------------------------------------------------

function tokenize(s: string): ReadonlySet<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((t) => t.length > 2), // drop noise like "a", "on", "id"
  );
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

interface KnownVocabulary {
  readonly code: string;
  readonly recoveryClass: RecoveryClass;
  readonly source: string;
  readonly tokens: ReadonlySet<string>;
}

const VOCABULARY: readonly KnownVocabulary[] = FAILURE_REASONS.map((r) => ({
  code: r.code,
  recoveryClass: r.recoveryClass,
  source: r.source,
  tokens: tokenize(`${r.code} ${r.description}`),
}));

/** Below this, no known code shares enough vocabulary to be worth a guess. */
const MATCH_THRESHOLD = 0.15;

/**
 * @param errorSource Razorpay's own `error_source` field, when available
 *   (present on the live API, absent in the simulator, which has no notion of
 *   an "unknown" code at all -- see the honesty note in `eval/novelty.ts`).
 *   Used only as a consistency check: a token match whose usual source
 *   disagrees with the reported one is treated as unreliable, not silently
 *   trusted.
 */
export function deterministicFallback(
  reasonCode: string,
  errorSource?: string,
): FallbackInterpretation {
  const tokens = tokenize(reasonCode);
  let best: (KnownVocabulary & { score: number }) | undefined;
  for (const candidate of VOCABULARY) {
    const score = jaccard(tokens, candidate.tokens);
    if (!best || score > best.score) best = { ...candidate, score };
  }

  if (!best || best.score < MATCH_THRESHOLD) {
    return {
      recoveryClass: null,
      confidence: 'low',
      evidence: [
        `"${reasonCode}" shares no meaningful vocabulary with any of the ${VOCABULARY.length} documented reason codes` +
          (best ? ` (closest: "${best.code}" at ${(best.score * 100).toFixed(0)}% token overlap, below threshold)` : ''),
      ],
    };
  }

  const sourceConsistent = errorSource === undefined || errorSource === best.source;
  if (!sourceConsistent) {
    return {
      recoveryClass: null,
      confidence: 'low',
      evidence: [
        `"${reasonCode}" resembles "${best.code}" (${(best.score * 100).toFixed(0)}% token overlap), ` +
          `but the reported error source "${errorSource}" does not match that code's usual source ` +
          `(${best.source}) -- treating the match as unreliable rather than guessing anyway`,
      ],
    };
  }

  return {
    recoveryClass: best.recoveryClass,
    confidence: 'medium', // never high: a string match is not a documented fact
    evidence: [
      `"${reasonCode}" shares ${(best.score * 100).toFixed(0)}% token overlap with the documented ` +
        `code "${best.code}" (${best.recoveryClass})` +
        (errorSource ? `; reported source "${errorSource}" is consistent with that code's usual source` : ''),
    ],
  };
}

// --------------------------------------------------------------------------
// Part A: the assessment itself.
// --------------------------------------------------------------------------

function detectAnomalies(ctx: CaseContext): string[] {
  const anomalies: string[] = [];

  if (ctx.event.amountPaise <= 0) {
    anomalies.push(`non-positive amount (${ctx.event.amountPaise} paise)`);
  }

  const executedRetries = ctx.history.filter(
    (h: HistoryEntry) => h.action.kind === 'retry_payment' && h.blockedBy === undefined,
  ).length;
  if (executedRetries !== ctx.attemptCount) {
    anomalies.push(
      `attemptCount (${ctx.attemptCount}) does not match executed retries in history (${executedRetries})`,
    );
  }

  const executedContacts = ctx.history.filter(
    (h: HistoryEntry) => h.action.kind === 'contact_customer' && h.blockedBy === undefined,
  ).length;
  if (executedContacts !== ctx.contactCount) {
    anomalies.push(
      `contactCount (${ctx.contactCount}) does not match executed contacts in history (${executedContacts})`,
    );
  }

  return anomalies;
}

/**
 * Deterministic, pure, `CaseContext`-only. Never reads ground truth.
 *
 * @param interpretUnknown  optional external interpreter for an
 *   unrecognised reason code (see `UnknownReasonInterpreter` above). Omit
 *   entirely and the deterministic fallback still runs -- this parameter can
 *   only ever narrow the gap between "unknown" and "inferred", never promote
 *   anything to "known" or to HIGH confidence.
 *
 * Whether THIS step's assessment differs from the previous step's is a
 * separate, purely comparative question -- see `assessmentChanged` and
 * `case-state.ts:deriveState`, which recomputes the prior step's assessment
 * from a one-shorter history rather than asking every caller to thread it
 * through by hand.
 */
export function assess(
  ctx: CaseContext,
  interpretUnknown?: UnknownReasonInterpreter,
): CaseAssessment {
  const anomalies = detectAnomalies(ctx);
  const { reasonCode } = ctx.event;

  if (reasonCode === undefined) {
    // Legitimately absent, not malformed: abandonment-style losses have no
    // Razorpay failure reason because nothing was ever submitted to fail.
    if (ctx.event.lossType === 'checkout_abandonment') {
      return {
        status: 'inferred',
        recoveryClass: 'ABANDONMENT',
        confidence: anomalies.length > 0 ? 'low' : 'medium',
        evidence: [
          'no reason code, but the loss type is checkout_abandonment: the customer never completed checkout, which is what ABANDONMENT means',
        ],
        anomalies,
      };
    }
    return {
      status: 'unknown',
      recoveryClass: undefined,
      confidence: 'low',
      evidence: ['no reason code, and the loss type does not by itself imply a class'],
      anomalies,
    };
  }

  const known = lookupReason(reasonCode);
  if (known) {
    return {
      status: 'known',
      recoveryClass: known.recoveryClass,
      // An anomaly means SOMETHING about this case's context is not what the
      // model expects, even though the code itself is documented -- worth
      // one notch of caution, not a full demotion to "unknown".
      confidence: anomalies.length > 0 ? 'medium' : 'high',
      evidence: [`reason code "${reasonCode}" is documented: ${known.description}`],
      anomalies,
    };
  }

  const external = interpretUnknown?.({ reasonCode });
  const fallback = external ?? deterministicFallback(reasonCode);

  if (fallback.recoveryClass) {
    return {
      status: 'inferred',
      recoveryClass: fallback.recoveryClass,
      // Capped at MEDIUM regardless of source (external or deterministic),
      // and demoted further if this case also has an unrelated anomaly.
      confidence: anomalies.length > 0 ? 'low' : 'medium',
      evidence: fallback.evidence,
      anomalies,
    };
  }

  return {
    status: 'unknown',
    recoveryClass: undefined,
    confidence: 'low',
    evidence: fallback.evidence,
    anomalies,
  };
}

/** Used by the previous-step comparison in `deriveState` -- see `case-state.ts`. */
export function assessmentChanged(a: CaseAssessment | undefined, b: CaseAssessment): boolean {
  if (!a) return false; // nothing to compare against on the first step
  return a.status !== b.status || a.confidence !== b.confidence || a.recoveryClass !== b.recoveryClass;
}
