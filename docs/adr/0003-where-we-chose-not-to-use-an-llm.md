# ADR 0003 — Where we chose *not* to use an LLM

**Status:** Accepted
**Date:** 2026-09-02

## Context

This is an AI buildathon. The obvious move is to put a language model in the
middle of everything and call it an agent.

We decided early that the interesting question was not *where can an LLM go*,
but *where does an LLM earn its place, and where is it actively the wrong tool*.

## Decision

An LLM is used in exactly one place: **proposing a recovery action for a case
whose failure reason does not map cleanly onto a known playbook.**

Everywhere else, deterministic code:

| Component | Implementation | Why not an LLM |
|---|---|---|
| **Compliance rules** | Deterministic (`guardrails/compliance.ts`) | Quiet hours, DND and consent are legal constraints. A probabilistic system that respects them 99.7% of the time is a system that breaks the law twice a week. There is no upside to creativity here. |
| **Stopping rules** | Deterministic (`guardrails/limits.ts`) | Retry caps exist to prevent runaway behaviour. Asking the thing being bounded to enforce its own bound is not a control. |
| **Failure classification** | Lookup table (`domain/failure-taxonomy.ts`) | Razorpay publishes a finite, documented list of error codes. Mapping 21 known strings to 6 classes is a dictionary. Using a model for it would add latency, cost and non-determinism to buy nothing. |
| **Retry timing** | Fixed schedules per class (`policies/playbook.ts`) | The reasoning is stable and explainable. A merchant asking "why did you retry at 20 hours?" deserves a rule, not a sample. |
| **Expected-value arithmetic** | Plain arithmetic | It is multiplication. |
| **Novel/ambiguous cases** | **LLM** | Here the input is genuinely open-ended and the alternative is giving up. This is where a model adds something rules cannot. |

## The shape of the constraint

> **The brain proposes, the brakes decide.**

The policy layer — rules or LLM — only ever *returns a proposed action*. It has
no capability to execute anything. Every action passes through `guardrails.gate()`,
which is deterministic, and the engine will not execute without an `allow`
verdict.

This is structural, not a convention. There is no code path from a policy to an
executed action that bypasses the gate, and `rules-agent.test.ts` includes an
adversarial policy that tries to breach every limit and cannot.

The practical consequence: **the LLM can be wrong, or prompt-injected, or
hallucinate a JSON blob demanding forty voice calls at 3am, and the system still
behaves.** Worst case it wastes a decision cycle and the ledger records why it
was refused.

## Consequences

**Good**

- Compliance is provable rather than probable. `complianceViolations` is 0 across
  every scenario and strategy, including the adversarial one, and it is measured
  rather than asserted.
- The system runs, and runs well, with no API key at all. The LLM is additive.
- Cheap: one model call per ambiguous case, not one per decision.

**Bad**

- Less impressive-sounding than "fully autonomous LLM agent".
- Playbooks are hand-written, so a genuinely novel failure mode needs a human to
  extend the taxonomy.

**Accepted trade**

For a payments company, a system that is boring in the right places is the point.
We would rather be asked why we used *so little* AI than explain why an LLM was
permitted to decide whether contacting a DND-registered customer was acceptable.
