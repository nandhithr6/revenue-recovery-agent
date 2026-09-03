# Contributing

This started as a Razorpay AI Buildathon submission (Track 03 — AI Revenue
Recovery). The notes below are for anyone extending it afterward, including
future-me.

## Before you touch anything

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. The short version:

```
LossEvent ──> Diagnose ──> Policy ──> Guardrails ──> Execute ──> Ledger
```

The policy layer only ever *proposes* an action. It cannot execute one.
Guardrails decide, independently, and the engine executes only on an
`allow` verdict. This separation is structural, not a convention — a test
suite runs an adversarial policy that deliberately tries to breach every
limit, and it cannot. If a change makes it possible for a policy to bypass
a guardrail, that change is wrong regardless of what else it improves.

The other rule that cannot bend: **the agent must never read the
simulator's ground truth** (`sim/recovery-model.ts`). It sees a
`CaseContext` and nothing else. `policies/boundary.test.ts` enforces this
by checking the import graph of every policy file — an agent grading its
own exam proves nothing.

## Setup

```bash
npm install
npm test
```

If that passes, you're set up correctly. No external services, no API
keys — everything runs on free tiers and the whole test suite is offline
by default (the optional LLM policy caches its responses in
`out/llm-cache.json` and falls back to the deterministic agent if
unreachable).

## Running things

```bash
npm run eval                    # one scenario, full CLI report
npm run eval:all                # all 5 scenarios, writes the dashboard's bundle
npm run eval:robust             # 250 reseeded cohorts — is the result one lucky seed?
npm run eval:sensitivity        # sweeps the annoyance price ₹0–100
npm run eval:novelty            # 12 adversarial cases, safety not revenue
npm run eval:all && npm run dashboard   # the dashboard, reading eval:all's own output
npm test                        # the full suite
npm run typecheck               # tsc --noEmit
```

The dashboard never simulates anything itself — it only reads
`out/all-results.json`. If a number looks wrong there, the bug is upstream,
in the simulation or the evaluator, not in the dashboard.

## Making a change

1. **If you're changing agent behaviour** (`src/policies/`), write down what
   you expect to happen and why *before* running the eval — the honest way
   to catch a bug is to notice your own prediction was wrong, not to stare
   at an aggregate number until a story suggests itself. See engineering
   log entries 15 and 16 for what this looks like in practice.
2. **Never tune a constant to make the benchmark look better.** If a change
   makes the numbers worse but the reasoning more correct, keep the correct
   version and say so. `docs/ENGINEERING-LOG.md` exists specifically to
   record that kind of trade honestly — add an entry.
3. **Rerun everything, not just the scenario you touched.** `eval:robust`
   and `eval:sensitivity` exist to catch a change that helps one scenario
   and quietly hurts four others. A PR that only reruns `eval:all` on
   baseline-week hasn't actually checked its own claim.
4. **Add a test for what you fixed**, not just for what you added. A
   regression test that would have caught the bug you just fixed is worth
   more than a test for the happy path you already knew worked.
5. **Keep the CLI and the dashboard in sync.** `npm run eval` and
   `npm run eval:all` must produce byte-identical numbers for the same
   scenario and seed — that's the whole point of not having the dashboard
   simulate anything itself. If you add a new metric, it needs to come from
   the same evaluator both paths call, not a second calculation.
6. **If you add a Razorpay `reason` code**, put it in
   `src/domain/failure-taxonomy.ts` with its real, documented description
   and source. Adding a taxonomy entry does not by itself change what the
   simulator generates — a scenario's `failureMix` in `sim/scenario.ts`
   has to weight it before it appears in any cohort. Don't wire a new code
   into a scenario's weights without also rerunning `eval:robust` — that's
   a real change to the benchmark, not free.

## Code style

- No comments that restate what the code already says. A comment earns its
  place by explaining a non-obvious *why* — a constraint, a prior bug, a
  reason the obvious-looking alternative is wrong. Most of this codebase's
  comments cite a specific reason or an engineering-log entry; match that.
- Money is integer paise everywhere, never floating-point rupees. If you
  see a raw `amountPaise / 100` outside a display-formatting function,
  that's a bug waiting to happen, not a style choice.
- Prefer a named constant with a one-line reason over a bare number. If you
  can't write one honest sentence for why a constant has the value it has,
  that's worth noticing before you commit it.

## Tests

`npm test` runs everything, including:
- an adversarial policy that tries to breach every guardrail and cannot
- the ground-truth import boundary check
- the financial benchmark's own regression tests (candidate pricing,
  dominance annotation, the expected-vs-actual distinction)
- novelty/safety fixtures, kept separate from the revenue numbers on
  purpose

If you're fixing a bug, the PR should contain a test that fails on `main`
and passes with your fix — not just a fix.

## What not to do

- Don't modify `sim/recovery-model.ts` (ground truth) to make the agent
  look better. If the agent should legitimately behave differently, fix
  the agent's own belief model (`policies/adaptive-model.ts`), which is
  explicitly forbidden from reading ground truth at runtime.
- Don't add an LLM call to the decision-critical path. One narrowly-scoped
  LLM already exists (`src/llm/unknown-error.ts`, capped at medium
  confidence, never selects an action) — see
  [ADR 0003](docs/adr/0003-where-we-chose-not-to-use-an-llm.md) for why the
  rest of the system stays deterministic.
- Don't remove a disclaimer or a "not run yet" fallback from the dashboard
  to make a section look more complete than the data actually is.
