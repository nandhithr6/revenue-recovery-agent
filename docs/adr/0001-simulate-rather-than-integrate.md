# ADR 0001 — Simulate the rails, adopt Razorpay's real vocabulary

**Status:** Accepted
**Date:** 2026-09-02

## Context

A recovery agent needs failed payments to work on. Two options: integrate the
Razorpay sandbox API for real, or simulate.

## Decision

Simulate execution. Adopt Razorpay's **real documented error taxonomy**.

The `reason` codes in `domain/failure-taxonomy.ts` are Razorpay's own, for both
cards and UPI, taken from their public error documentation. What is ours is the
mapping from each reason to a recovery class, and the recovery-probability
curves in `sim/recovery-model.ts`.

## Why

- A live integration would consume most of a day of a three-day build — signup,
  activation, key management — and still would not produce *failed* payments at
  the volume or variety needed. Sandboxes are good at success paths.
- Measuring recovery needs hundreds of cases with known ground truth. A sandbox
  cannot give you that at all: you would never know whether a retry *would* have
  worked.
- Speaking the real vocabulary buys most of the credibility for a fraction of the
  cost. The taxonomy would not need rewriting to point this at a production
  webhook feed; only the executor would change.
- Including the UPI codes (`invalid_vpa`, `vpa_resolution_failed`,
  `payment_collect_request_expired`) matters disproportionately. UPI is how India
  actually pays, and a card-only taxonomy would be a Western system with a rupee
  sign stuck on it.

## On card data

The retry path never handles raw card details. A recovery action references the
original payment by its identifier and asks the gateway to re-attempt it — which
is both how Razorpay's API actually works and what RBI's card-on-file
tokenisation rules require, since merchants may not store PANs. Nothing in this
design would need to change to run against live rails.

## Consequences

- Results demonstrate **policy quality**, not production rupees. Stated plainly
  in `docs/SOURCES.md` and never claimed otherwise.
- Every assumption is a named, commented constant rather than a number buried in
  a function body.
- The honest limitation: our recovery curves are reasoned, not measured. Someone
  with real merchant data would get different absolute numbers. The *ranking* of
  strategies is the claim, and it rests on every strategy facing identical
  cohorts under a fixed seed.
