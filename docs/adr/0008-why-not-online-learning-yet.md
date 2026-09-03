# ADR 0008 — Expected-value scoring now; cross-case learning deferred, and why

**Status:** Accepted
**Date:** 2026-09-03

## Context

`agent-rules` answers "what class is this, what does the fixed playbook for
that class say" — one precomputed path per class. That is a real improvement
over a reason-blind schedule, but it is still the same *shape* of answer as
fixed dunning: a lookup table with better numbers in it. A more serious
critique, put directly: fixed dunning is a weak opponent not because its
numbers are bad but because it structurally cannot condition on anything —
not the amount, not how many times this case has already failed, not what
channel already got a decline. Beating a benchmark that cannot see the board
is not the same as reasoning well.

The full ask that prompted this ADR went further: give the agent genuine
case memory, and let it update its own recovery-probability estimates online
from outcomes it observes as the simulation runs — a Bayesian Beta/Binomial
estimator, or a lightweight contextual bandit, so the agent "gets better as
it watches."

## Decision

Build the first half now (`agent-adaptive`, alongside — not replacing —
`agent-rules`): genuine expected-value scoring across a shortlist of
candidate actions, each priced in rupees, with the highest-value candidate
taken. Candidates are evaluated against continuous-time belief curves
(`adaptive-model.ts`) rather than three or four fixed offsets, so the
question actually being asked is "at literally any moment from now to two
weeks out, what would this be worth," not "which of these three pre-picked
moments is least bad."

**Defer cross-case online learning.** Not because it is a bad idea — it is a
genuinely good one — but because of what it would cost to do safely.

## Why the deferral, specifically

A `Strategy.decide(ctx)` today is a pure function: same `CaseContext` in,
same `Action` out, every time, for every case, independent of every other
case. That purity is load-bearing in three places:

1. **The robustness harness** reruns every scenario across 50 independent
   seeds and expects each run to be a clean, independent draw. A strategy
   that remembers outcomes across cases within a run introduces
   *within-run* correlation between case 1 and case 500 that the harness was
   never built to account for — the reported variance would understate the
   truth.
2. **The sensitivity sweep** rebuilds the agent at each price point and
   compares like for like. A learning agent's trajectory would differ by
   price in ways that are themselves worth studying, but conflate "the price
   changed the policy" with "the policy learned differently this run" unless
   the harness is redesigned to hold the learning trajectory fixed across
   price points — nontrivial, and easy to get subtly wrong.
3. **The live Razorpay path** runs a handful of hand-seeded cases, nowhere
   near enough volume for an online estimator to move off its prior. A
   learning agent would behave identically to a non-learning one there in
   practice, so the live proof would not actually demonstrate the feature.

None of these are unsolvable. They are real engineering, on the order of
redesigning the `Strategy` interface to optionally carry state, threading
that through four call sites, and re-verifying that every existing measured
claim (244/250, the sensitivity sweep, zero compliance violations) still
means what it says once "the same strategy" no longer means "the same
function" across a run. Two days before a submission deadline, on top of an
already-tested, already-measured system, is not when to take that on for a
feature whose payoff is genuinely uncertain here: our simulator's curves are
fixed-shape and already known well enough that a good closed-form estimate
gets most of the value a learned one would find. Online learning earns its
keep against a distribution you do not already understand; ours is one we
wrote.

## What a follow-up would need

- `Strategy` gains an optional `createState()` / `(state, ctx) => [Action,
  state]` shape, defaulting to stateless for existing policies.
- `runCohort` threads state through sequential `runCase` calls instead of a
  shared bare RNG.
- The robustness harness either resets state per seed (the honest choice) or
  explicitly reports within-run correlation.
- The sensitivity sweep either fixes the learning trajectory across price
  points or documents that it does not.
- A Beta-Binomial estimator per (recovery class, action, coarse time bucket),
  updated from each case's real outcome, Thompson-sampled or upper-confidence
  selected among near-tied candidates — explainable, no black-box model,
  fully TypeScript.

## Consequences

**Good:** `agent-adaptive` ships now, genuinely reasons about amount, elapsed
time and attempt count in a way fixed dunning structurally cannot, and does
so without touching the architecture that every other measured claim in this
project depends on.

**Bad:** it will not "get better as it watches." Its beliefs are fixed at
build time, same integrity boundary as `agent-rules` — independent of
`sim/recovery-model.ts`, deliberately approximate, sometimes deliberately
wrong.

**Honest framing for the writeup:** two decision layers were built and
measured against each other and against fixed dunning — a rules engine and
an expected-value optimizer. A third, learning, layer was designed and
explicitly not built, and here is exactly why not.
