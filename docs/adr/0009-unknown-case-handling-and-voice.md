# ADR 0009 — Unknown-case handling, a formal action registry, and voice

**Status:** Accepted
**Date:** 2026-09-03

## Context

Every claim this project had made about `agent-adaptive` assumed the case in
front of it was one of the six documented recovery classes. `classify()`
had exactly two states: a recognised reason code, or `STOP('unrecognised
failure reason; refusing to act blindly')`. That is safe, but it is not
capable — a real deployment will eventually see a reason code Razorpay adds
next quarter, a malformed field, or a case whose own bookkeeping doesn't add
up, and "refuse to act blindly" is the right instinct applied with no
gradation at all.

Separately, `Channel` has included `'voice'` since early in the project —
its cost, its spam price, its DND coverage, its believed landing odds were
all already defined — but `agent-adaptive`'s contact ladder never actually
offered it. And every customer contact resolved to a plain boolean
(`succeeded`), which meant there was no way for a channel to carry back
anything richer than "landed or didn't."

## Decision

Four additions, described in the design review this ADR formalises:

1. **`CaseAssessment`** (`policies/assessment.ts`) — replaces the binary
   classify-or-stop gate with three states (`known` / `inferred` /
   `unknown`) and three confidence bands (`high` / `medium` / `low`),
   computed deterministically from `CaseContext` alone. An unrecognised
   reason code is no longer a dead end: a deterministic fuzzy-matcher
   (token overlap against the 21 documented codes, checked for consistency
   against a reported error source) can infer a class at MEDIUM confidence,
   never higher. An optional external interpreter — an LLM, if configured —
   can plug into the exact same seam and is hard-capped at MEDIUM too; see
   `llm/unknown-error.ts`.

2. **Confidence-gated candidate generation** (`policies/action-registry.ts`,
   `menuFor`) — uncertainty changes WHICH actions are even offered, never
   how a fixed set is scored. HIGH confidence gets the full menu. MEDIUM
   drops voice and human escalation unless nothing cheaper clears cost.
   LOW/unknown drops retry entirely, offers at most one cheap contact
   channel, and prices escalation as an honest "route to human review"
   hedge rather than a recovery channel. No confidence multiplier exists
   anywhere in the pricing math — the alternative this ADR explicitly
   rejected, because a multiplier tuned to look right on a benchmark is
   indistinguishable from a multiplier tuned to game one.

3. **A static `ActionSpec` registry** (`policies/action-registry.ts`) —
   retry, four channels, escalation and stop are now one array of specs
   (eligibility, pricing, consent/reversibility metadata) instead of three
   growing inline blocks. No dynamic loading, no external configuration;
   the registry is exactly as static as the code it replaced.

4. **Voice, with a structured outcome** (`domain/types.ts:CustomerSignal`,
   `sim/voice-signal-model.ts`, `eval/engine.ts`) — voice is now priced by
   the same formula every other channel already used, competing honestly on
   its own higher cost and higher landing odds. Uniquely, a voice call that
   connects draws one of six structured signals (`promise_to_pay`,
   `funds_available_now`, `instrument_fixed`, `disputes_charge`, `refused`,
   `no_answer`) from a new, independently-authored ground-truth
   distribution, instead of a plain boolean. The signal is written to
   `HistoryEntry.signal` and read back by `agent-adaptive` on its next
   `decide()` call — which already runs every step, so no new control flow
   was needed for "the agent replans." `promise_to_pay` and
   `funds_available_now` feed the SAME `wait`/`customerActed` mechanisms
   already built for receivables; `disputes_charge`/`refused` end the case;
   `no_answer` changes nothing, deliberately.

## What did NOT change

- `sim/recovery-model.ts` — untouched. No policy file imports it; a
  boundary test (`policies/boundary.test.ts`) now checks every new policy
  file the same way `adaptive-agent.test.ts` already checked the original
  two, plus the new `sim/voice-signal-model.ts` ground truth.
- `Strategy.decide(ctx) => Action` — still a pure, stateless function.
  `CaseState` (`policies/case-state.ts`) is derived fresh from `ctx` every
  call; nothing survives between cases or between cohort runs. ADR 0008's
  reasoning against cross-case learning is untouched.
- The financial benchmark's methodology — `eval:robust`, `eval:sensitivity`,
  and the five scenarios are unmodified. Novelty/safety evaluation
  (`eval:novelty`) is a deliberately separate suite with its own file, its
  own dashboard section, and no ₹ figure — see the section header in the
  dashboard itself.

## Consequences

**Good:** the agent now has a real, if bounded, answer to "what if this
case is nothing like the five scenarios" — one that gets more conservative
as evidence gets thinner rather than either freezing or overreaching. Voice
is a genuine lever the optimizer can pull, not a demo prop: it only wins
the argmax when its cost is actually worth paying.

**Bad, and worth saying plainly:** the deterministic fallback's "error
source consistency" check is currently a no-op for every simulated
case — `LossEvent` carries no `errorSource` field, only the live Razorpay
path would ever supply one, so `deterministicFallback` is always called
with `errorSource: undefined` today, and the consistency branch never
actually disagrees with anything. The voice-signal ground truth is
authored, not measured, same honesty caveat as every curve in
`sim/recovery-model.ts` — see the honesty note already in
`adaptive-model.ts`, which applies here too.
