# ADR 0002 — Guardrails live outside the policy

**Status:** Accepted
**Date:** 2026-09-02

## Context

The agent decides whether to retry a payment or message a customer. Both touch
money and both touch people. Something has to enforce the limits.

The tempting design is to write the limits into the policy: "retry at most five
times, never message after 9pm." One component, less indirection.

## Decision

Limits live in a separate deterministic layer that every action passes through.

> **The brain proposes, the brakes decide.**

`Strategy.decide()` returns a proposed `Action`. It has no capability to execute
anything. The engine calls `guardrails.gate()` and executes only on `allow`.

## Why

A policy that enforces its own limits is not bounded — it is *politely
self-restrained*, which is a different property. It holds only while the policy
behaves.

That distinction stops being academic the moment an LLM writes the policy. A
model that has been prompt-injected, or that simply produces a confident wrong
answer, is exactly the case the limits exist for. If the limits live inside the
thing that failed, they failed with it.

Separating them means correctness does not depend on policy quality. The
adversarial policy in `guardrails.test.ts` tries to retry infinitely and
voice-call at 3am on repeat. It cannot, and its failure to is asserted rather
than assumed.

## Structure

```
Strategy.decide()  ->  Action (a proposal)
                          |
                   guardrails.gate()      <- deterministic
                    /            \
              allow              defer / block
                |                      |
          engine executes        ledger records the rule
```

Two ordering rules inside the gate:

1. **Limits before compliance** — cheaper, and a case with no budget left should
   not be evaluated for anything else.
2. **Permission rules before timing rules** — no point deferring an action that
   would never be permitted. See ADR 0006.

## Consequences

- `complianceViolations` is 0 by construction, and measured rather than asserted:
  the metric counts executed ledger entries carrying a rule, which would be
  non-zero if the gate were ever bypassed.
- Blocked actions are recorded, not silently dropped. "We did not contact them,
  and here is the rule that stopped us" is itself the compliance evidence.
- Cost: policies must read `history` for `blockedBy` to avoid re-proposing
  refused actions. The agent does. Fixed dunning does not, and loops until the
  engine step limit — which turned out to be a useful illustration of the
  difference between a policy that learns from its environment and one that does
  not.
