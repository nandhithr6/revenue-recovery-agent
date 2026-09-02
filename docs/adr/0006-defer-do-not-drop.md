# ADR 0006 — Compliance defers, it does not drop

**Status:** Accepted
**Date:** 2026-09-02

## Context

A payment fails at 20:30. The agent works out that the right moment to reach the
customer is 60 minutes later. At 21:30 the contact hits quiet hours.

The simple implementation refuses the action and moves on. The revenue is lost to
a technicality of timing, and the customer is never told their payment failed.

## Decision

Guardrail verdicts are three-valued, not two:

| Verdict | Meaning | Example |
|---|---|---|
| `allow` | Proceed now | Daytime contact on a consented channel |
| `defer` | Not now, but from *this* timestamp | Quiet hours, cooldowns, daily caps |
| `block` | Never, for this customer and channel | DND, missing consent, retries exhausted |

`nextPermittedContactTime()` computes the next instant outside quiet hours in the
customer's local time. The engine advances the clock and re-evaluates. A message
that would have landed at 21:30 is queued for **09:00 the next morning** rather
than dropped.

## The distinction that matters

Timing rules and permission rules differ in kind:

- **Timing** rules are about *when*. Waiting fixes them, so deferring is correct.
- **Permission** rules are about *whether*. Waiting never fixes them, so
  deferring would build a queue of contacts we may never legally make.

Getting this backwards is expensive in both directions. Treat timing as
permission and you throw away recoverable revenue; treat permission as timing and
you accumulate pending violations. The gate therefore evaluates permission rules
first — there is no point computing a deferral for an action that is never
allowed. A test covers exactly this: a DND-registered customer contacted at 03:00
is blocked, not deferred, even though both rules apply.

## Consequences

- Deferral is bounded. `MAX_DEFERRALS_PER_ACTION = 4` and a three-day span cap,
  so a case cannot be postponed indefinitely. Exceeding either is recorded as
  `DEFERRAL_LIMIT` and the action is abandoned.
- Deferrals are ledger entries in their own right. The audit trail shows the
  agent *wanting* to act, the rule that stopped it, and when it was rescheduled
  to — which is a more useful record than silence.
- The agent expresses retry offsets from the **original failure**, not from
  "now", so a deferred action does not drift later each time it is postponed.
