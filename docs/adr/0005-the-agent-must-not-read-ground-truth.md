# ADR 0005 — The agent must not read the simulator's ground truth

**Status:** Accepted
**Date:** 2026-09-02

## Context

`sim/recovery-model.ts` holds the true probability that a retry succeeds at any
given moment. The agent's entire job is to pick good moments.

Importing that file into the agent would make it optimal instantly.

## Decision

`policies/playbook.ts` and `policies/rules-agent.ts` must never import from
`sim/recovery-model.ts`. The agent carries its own independent belief table.

Enforced by a test that reads both source files and asserts no such import
exists. A comment would be a hope; the test is the wall.

## Why

An agent reading the answer key is grading its own exam, and every number it
produces afterwards is meaningless. The result would look excellent and prove
nothing at all.

The agent's beliefs are deliberately approximate and, in places, deliberately
wrong — it thinks `TRANSIENT_FUNDS` peaks around 24 hours when the simulator
peaks nearer 30. It has to win with imperfect information, because imperfect
information is the only kind anyone has in production.

`CaseContext` is the other half of the same wall. It carries the failure reason,
the amount, the customer's consent flags and the case history, and nothing else.
It deliberately excludes the recovery class, the true odds, and whether the
customer would respond to a nudge. The agent infers the recovery class from the
reason code itself, which is legitimate: Razorpay publishes what each code means.

## Consequences

- The results mean something.
- The agent is beatable, and on `bank-outage` it is in fact beaten by fixed
  dunning. See the engineering log. That is the price of an honest setup and it
  is worth paying.
- One subtlety worth naming: the agent *can* observe that a contact `succeeded`,
  which tells it the customer acted on a nudge. This is legitimate rather than
  privileged — in production that signal arrives as a webhook when a card is
  updated or a mandate is re-authorised.
