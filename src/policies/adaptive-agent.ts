import { DAY, type Action, type Paise } from '../domain/types.js';
import { DEFAULT_LIMITS } from '../guardrails/limits.js';
import type { CostModel } from '../sim/scenario.js';
import { buildCandidates, type Candidate } from './action-registry.js';
import type { CaseAssessment, UnknownReasonInterpreter } from './assessment.js';
import { deriveState, type CaseState } from './case-state.js';
import { LOSS_PROFILES } from './loss-profiles.js';
import { SPAM_POINT_PRICE_PAISE } from './playbook.js';
import { STOP, type CaseContext, type Strategy } from './types.js';

/**
 * The adaptive recovery agent: `assess -> price candidates -> argmax`.
 *
 * `agent-rules` answers "what class is this, what does the playbook for that
 * class say" -- a single precomputed path per class, same shape of answer as
 * fixed dunning, just with better numbers. This agent instead builds a short
 * list of CANDIDATE actions for the case in front of it -- retry now, retry
 * at several later moments, message on each available channel (including
 * voice), escalate, stop -- prices every one of them in rupees via the
 * `ActionSpec` registry (`action-registry.ts`), and takes whichever is worth
 * the most. A candidate that never clears its cost is simply never picked;
 * "stop" is always in the running at a fixed value of zero.
 *
 * What decides here versus what decides elsewhere:
 *   - `assess()` (`assessment.ts`) decides how much this decision should
 *     trust its own inputs -- known / inferred / unknown, high / medium / low.
 *   - `buildCandidates()` (`action-registry.ts`) decides WHICH actions are
 *     even offered, gated by that confidence -- a smaller, safer menu when
 *     evidence is thin. It does not touch the pricing math of anything still
 *     in the running.
 *   - `explain()` below does the argmax, and nothing else.
 *   - `guardrails/index.ts:gate()` (called by the engine, not by this file)
 *     has the final, unconditional word on whether a proposal executes.
 *
 * `decide()` is a thin wrapper over `explain()` -- ONE place computes the
 * candidate list and picks the winner. This matters beyond tidiness: it is
 * what lets the dashboard show "why" a decision was made (the full priced
 * candidate table, not just the winner) with a mathematical guarantee that
 * the display can never diverge from the real decision, because both read
 * the same call.
 *
 * A Rs 500 case and a Rs 80,000 case carrying the SAME failure reason can
 * legitimately receive different treatment -- not because of a special case
 * in the code, but because expected value scales with the amount and a fixed
 * cost does not. Fixed dunning cannot do this: its schedule has no amount in
 * it at all.
 *
 * Deliberately NOT built here: cross-case learning. `deriveState` and
 * `assess` are pure functions of THIS case's own history, recomputed fresh
 * every call -- nothing survives between cases or between cohort runs. See
 * docs/adr/0008-why-not-online-learning-yet.md.
 */

const TERMINAL_RULES: ReadonlySet<string> = new Set([
  'CASE_AGE_LIMIT',
  'KILL_SWITCH',
  'MAX_HUMAN_ESCALATIONS',
]);
const MAX_USEFUL_CASE_AGE_MS = DEFAULT_LIMITS.maxCaseAgeMs;

/**
 * How long a promise made over voice is honoured before it's treated as
 * broken and re-priced. Shorter than the 5-day receivable window
 * (`loss-profiles.ts`), which is a B2B invoicing cadence -- this is a
 * consumer voice call, and "I'll pay in two days" is the more natural
 * reading of the signal than a B2B payment-run cycle.
 */
const VOICE_PROMISE_WINDOW_MS = 2 * DAY;

export interface AdaptiveAgentOptions {
  /**
   * Optional interpreter for a reason code the taxonomy doesn't recognise --
   * the only seam an LLM-backed interpretation (see `llm/unknown-error.ts`)
   * plugs into. Omit entirely and the deterministic fallback in
   * `assessment.ts` still runs; nothing about eligibility, pricing, or
   * guardrails changes based on whether this is present.
   */
  readonly interpretUnknown?: UnknownReasonInterpreter;
}

/**
 * The full reasoning behind one decision: either a short-circuit (a
 * terminal rule fired, or a voice signal ended/deferred the case before any
 * candidate was ever priced -- there is nothing to compare in that case,
 * only a reason) or the complete priced candidate list plus which one won.
 */
export interface Explanation {
  readonly assessment: CaseAssessment;
  readonly state: CaseState;
  readonly action: Action;
  /** Absent exactly when `shortCircuitReason` is present -- nothing was priced. */
  readonly candidates?: readonly Candidate[];
  readonly shortCircuitReason?: string;
}

/**
 * Compute the decision AND the reasoning behind it, in one call. `decide()`
 * below is `explain(...).action` -- nothing in this function is special-cased
 * for display purposes, so the dashboard can show exactly what happened.
 */
export function explain(
  ctx: CaseContext,
  costs: CostModel,
  annoyancePricePaise: Paise = SPAM_POINT_PRICE_PAISE,
  options: AdaptiveAgentOptions = {},
): Explanation {
  const profile = LOSS_PROFILES[ctx.event.lossType];
  const state = deriveState(ctx, profile, undefined, options.interpretUnknown);
  const { assessment } = state;

  if (state.blockedRules.size > 0 && [...TERMINAL_RULES].some((r) => state.blockedRules.has(r))) {
    const fired = [...TERMINAL_RULES].filter((r) => state.blockedRules.has(r));
    const action = STOP(`case closed by ${fired.join(', ')}; no further action is permitted`);
    return { assessment, state, action, shortCircuitReason: 'terminal rule already fired' };
  }

  // ---- Voice signal reactions ----------------------------------------
  //
  // A structured voice outcome is an observation, not a special case: it
  // changes what THIS decision believes (via `state.customerActed`,
  // `state.promise`, or a direct stop below), and the very next
  // candidate-generation pass reflects that automatically. See Part G of
  // the design review -- these three branches are the only place a
  // signal is handled specially, and none of them fabricate a recovery
  // path the engine doesn't actually have (`disputes_charge`/`refused`
  // end the case rather than pretend a channel still helps;
  // `no_answer` falls through and changes nothing).
  if (state.lastSignal) {
    if (state.lastSignal.kind === 'disputes_charge' || state.lastSignal.kind === 'refused') {
      const action = STOP(
        `voice: customer ${state.lastSignal.kind === 'refused' ? 'declined to engage further' : 'disputes the charge'}; further contact is not appropriate`,
      );
      return { assessment, state, action, shortCircuitReason: `voice signal: ${state.lastSignal.kind}` };
    }
    if (state.lastSignal.kind === 'promise_to_pay' && state.lastSignalAt !== undefined) {
      const dueBy = state.lastSignalAt + VOICE_PROMISE_WINDOW_MS;
      if (ctx.now < dueBy) {
        const action: Action = {
          kind: 'wait',
          delayMs: dueBy - ctx.now,
          rationale: `voice: customer promised to pay; re-pricing once the ${VOICE_PROMISE_WINDOW_MS / DAY}-day window lapses`,
        };
        return { assessment, state, action, shortCircuitReason: 'honouring a voice promise-to-pay window' };
      }
      // Window lapsed without payment -- fall through. `customerActed`
      // is already true from the landed call, so the retry candidate
      // below prices this as "worth trying now", not as a fresh case.
    }
    // funds_available_now / instrument_fixed / no_answer: no special
    // branch needed. The first two already set `succeeded: true` on
    // their history entry (see `eval/engine.ts`), which is all
    // `state.customerActed` needs to flip the retry candidate onto its
    // immediate-retry pricing. `no_answer` changes nothing, on purpose.
  }

  // Receivables: a live, unbroken promise-to-pay (the pre-existing
  // mechanism, landed contact on any channel) is not a candidate to
  // price -- it is a reason to wait exactly until it is due.
  if (state.promise && !state.promise.broken) {
    const action: Action = {
      kind: 'wait',
      delayMs: Math.max(0, state.promise.dueBy - ctx.now),
      rationale: `receivable: commitment to pay recorded, re-pricing once the ${profile.promiseWindowMs / DAY}-day window lapses`,
    };
    return { assessment, state, action, shortCircuitReason: 'honouring a receivable promise-to-pay window' };
  }

  const candidates: readonly Candidate[] = buildCandidates({
    ctx,
    state,
    recoveryClass: assessment.recoveryClass,
    profile,
    costs,
    annoyancePricePaise,
  });

  const best = candidates.reduce((a, b) => (b.expectedValuePaise > a.expectedValuePaise ? b : a));

  const elapsed = ctx.now - ctx.event.occurredAt;
  if (best.action.kind === 'retry_payment' && best.action.delayMs === 0 && elapsed > 0) {
    if (elapsed > MAX_USEFUL_CASE_AGE_MS) {
      const action = STOP('past the useful case-age horizon');
      return { assessment, state, action, candidates, shortCircuitReason: 'case-age horizon' };
    }
  }

  // Tried and reverted: a "reprice at +24h, wait instead of stop if that
  // looks better" rule. It was theoretically motivated (same shape of bug
  // as entries 15-16, one level up) and passed every existing test, but
  // the FULL cohort re-eval made net value after annoyance WORSE
  // (Rs 5.36L -> Rs 5.08L), not better -- waiting consumed engine steps
  // and case lifetime on cases where the lookahead's isolated repricing
  // didn't reflect what actually happens when the case is genuinely still
  // open (contact fatigue, attempt counts and the case-age horizon all
  // interact with real elapsed history in ways the one-shot lookahead
  // didn't capture). Measured, not assumed to be safe from the theory
  // alone -- reverted because the data said no. See engineering log entry
  // 17 for the full account, including the numbers.
  return { assessment, state, action: best.action, candidates };
}

export function createAdaptiveAgent(
  costs: CostModel,
  annoyancePricePaise: Paise = SPAM_POINT_PRICE_PAISE,
  options: AdaptiveAgentOptions = {},
): Strategy {
  return {
    id: 'agent-adaptive',
    name: 'Adaptive agent',
    description:
      'Assesses each case (known / inferred / unknown, with a confidence band) before pricing candidates -- retry now, retry later, message on each channel including voice, escalate, stop -- and takes whichever clears the highest expected value. Low confidence shrinks the candidate menu rather than the arithmetic.',

    decide(ctx: CaseContext): Action {
      return explain(ctx, costs, annoyancePricePaise, options).action;
    },
  };
}
