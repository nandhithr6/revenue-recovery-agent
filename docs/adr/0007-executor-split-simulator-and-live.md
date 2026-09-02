# ADR 0007 — Split the executor: simulate to measure, run live to prove

**Status:** Accepted and implemented (npm run live)
**Date:** 2026-09-02
**Amends:** [ADR 0001](0001-simulate-rather-than-integrate.md), which chose pure
simulation. That decision is now partly reversed, and the reasoning that changed
is recorded below rather than quietly edited away.

## What changed

ADR 0001 declined a live Razorpay integration on the grounds that a sandbox is
good at success paths and cannot produce failures at the volume or variety
needed.

The first half of that is wrong, and checking it is what changed the decision.
**Razorpay test mode ships cards that deliberately trigger specific failure
codes** — `payment_timed_out`, `insufficient_fund`, `payment_cancelled`,
`gateway_technical_error`, `authentication_failed`,
`card_disabled_for_online_payments`, `card_declined` — free, on demand, with no
money moving. It also offers the Payment Links API and `payment.failed` webhooks.

The second half stands: a handful of hand-driven test payments still cannot
support a statistical claim about recovery rates.

So the honest conclusion is not "simulate" or "integrate". It is **both, for
different jobs.**

## Decision

Introduce an `Executor` interface at the single point that touches the outside
world. Everything above it is untouched.

```
Agent (unchanged) -> Guardrails (unchanged) -> Executor -> Ledger (unchanged)
                                                  |
                                    +-------------+-------------+
                                    |                           |
                            SimulatedExecutor          RazorpayExecutor
                            seeded, reproducible        live test mode
```

| | Simulator | Live test mode |
|---|---|---|
| Job | **Measurement** | **Proof it runs on real rails** |
| Volume | 500 cases x 5 scenarios x 30 seeds | a handful of cases |
| Reproducible | yes, seeded | no |
| Proves | the policy is better | the policy works against the real API |

## Why this shape

**The same agent, byte for byte, runs against both.** No branch in the policy, no
"if live" anywhere above the executor. That is a stronger claim than either path
alone, and it makes the layering in ADR 0002 into evidence rather than an
assertion: if the separation were wrong, swapping the executor would not be
possible without touching the agent.

It also protects the measurement. The live path cannot quietly become the source
of headline numbers, because it does not implement the seeded interface the
evaluator consumes.

## The line we will not cross

A dozen hand-driven payments prove nothing about recovery rates. The live run
produces real Razorpay ids and real error responses; it does **not** produce a
recovery percentage, and the README will say so. Presenting a handful of live
cases as a measurement would be the fastest way to lose a panel that understands
sample sizes.

## Consequences

**Good**

- Real API responses validate the taxonomy against reality rather than against
  documentation. We already found one thing to check: the test-card page says
  `insufficient_fund`, the error-code page says `insufficient_funds`.
- `contact_customer` becomes a genuine Razorpay Payment Link with a real URL in
  the ledger, not a mock.
- Ledger entries carry real `order_`, `pay_` and `plink_` ids. Those are the
  proof.

**Bad**

- Real time cost, against a deadline that also holds the robustness run, the
  sensitivity sweep, the dashboard rebuild and the video.
- A network dependency and an API key to keep out of the repo.

**Safety, non-negotiable**

- Test keys only: assert `rzp_test_` and refuse to run otherwise, so a live key
  cannot be used by accident.
- Keys live in `.env`, already gitignored, never logged or printed.
- The live path is opt-in via `npm run live`. `npm run eval`, `eval:all` and the
  entire test suite never touch the network.

**If time runs short:** a single real failure, correctly classified by the
unmodified agent, with a real Payment Link created, carries most of the
credibility of a full integration. Breadth of live coverage matters far less than
the fact that it runs at all.
