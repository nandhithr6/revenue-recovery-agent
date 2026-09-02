# Revenue Recovery Agent — Build Plan

**Track:** AI Revenue Recovery (Razorpay AI Buildathon)
**Deadline:** 5 Sept 2026 — direct submission: public repo + 5-min video + architecture doc
**Stack:** TypeScript / Node 22, end to end

---

## The bar we are being judged against

Razorpay states it directly:

> Don't just identify the problem. Show **measured money recovered across a batch**,
> with **compliant escalation**, **stopping rules**, and an **audit trail**.

Four requirements. Every design decision below traces to one of them.

| Requirement | Where it lives |
|---|---|
| Measured money across a batch | `src/eval/` — cohort runs, strategy comparison |
| Compliant escalation | `src/guardrails/compliance.ts` — quiet hours, DND, consent, caps |
| Stopping rules | `src/guardrails/limits.ts` — attempt caps, cooldowns, kill switch |
| Audit trail | `src/ledger/` — append-only, replayable, every decision reasoned |

---

## 1. The insight

Every naive recovery system treats losses identically. They are not identical.

Razorpay's own documented failure reasons split cleanly by what would actually fix them:

| Recovery class | Example reasons | Right move |
|---|---|---|
| `TRANSIENT_INFRA` | `bank_technical_error`, `gateway_technical_error` | Retry soon — infra blipped |
| `TRANSIENT_FUNDS` | `insufficient_funds`, `transaction_limit_exceeded` | Retry **later** — wait for a top-up |
| `CUSTOMER_ACTION_REQUIRED` | `card_expired`, `invalid_vpa` | Retry is futile — nudge the customer |
| `ABANDONMENT` | `payment_cancelled`, `payment_timed_out` | Intent may survive — re-engage |
| `AUTH_FAILURE` | `incorrect_cvv`, `authentication_failed` | A corrected attempt can work |
| `HARD_DECLINE` | `payment_risk_check_failed`, `debit_instrument_blocked` | Stop. Do not push. |

**And recovery is not free.** Each retry costs a gateway fee; each customer contact
costs goodwill. The objective is therefore not "recover the most" but:

> **maximise net value recovered, under a hard attempt budget and compliance rules.**

That framing is the project.

---

## 2. Architecture — one engine, pluggable loss types

The pipeline is identical whether the loss is a failed payment, an abandoned
checkout, or an overdue invoice. So we build it once.

```
 LossEvent ──> Detect ──> Diagnose ──> Policy ──> Guardrails ──> Execute ──> Ledger
 (pluggable)                             │            │                        │
                                    what to do?  allowed to?              append-only
                                                 ├─ stopping rules        audit trail
                                                 └─ compliance                 │
                                                                          Evaluator
                                                                    net value vs baselines
```

**Guardrails sit outside the policy.** The policy *proposes*; the guardrail layer
*disposes*. Even a hallucinating LLM policy cannot structurally exceed the attempt
cap or contact a customer during quiet hours. For a payments company evaluating
money-touching code, that separation matters more than any accuracy number.

### Loss-type adapters

Each is a small module implementing the same interface:

| Adapter | Razorpay direction covered |
|---|---|
| `payment-failure` | Payment degradation → root cause → recovery action |
| `checkout-abandonment` | Checkout drop-off recovery |
| `subscription-mandate` | Failed-subscription recovery + mandate retry sequencer |
| `receivable` | B2B receivables chaser + promise-to-pay tracker |

### Escalation ladder

Interventions are ordered by cost and intrusiveness. The agent climbs only as far
as the expected value justifies:

```
silent retry → email → SMS → WhatsApp → voice call → human review → write off
```

Hinglish message generation applies from the email rung onward. TTS voice is a
Day-3 stretch, not a dependency.

---

## 3. Compliance rules (India)

Encoded as hard constraints, not suggestions:

- **Quiet hours** — no customer contact 21:00–09:00 local
- **DND registry** — respect a do-not-disturb flag; retries still allowed, contact not
- **Consent** — per-channel opt-in required before use
- **Frequency caps** — max contacts per customer per day and per week
- **Cooling-off** — minimum gap between escalation rungs
- **Hard stop** — `HARD_DECLINE` never escalates; routes to risk review

Every block is written to the ledger with the rule that fired. "We didn't contact
them, and here is the rule that stopped us" is itself evidence of compliance.

---

## 4. Measurement

Beating "do nothing" is meaningless. We beat credible alternatives:

| Strategy | Description |
|---|---|
| `do-nothing` | The floor. Rupees 0. |
| `naive-retry` | Retry everything 3x immediately. What most people build. |
| `fixed-dunning` | Retry at +1h/+24h/+72h regardless of reason. What many real systems do. |
| `agent-rules` | Ours, deterministic |
| `agent-llm` | Ours, LLM-driven policy |

Scored on:

- **Net value recovered** = money recovered − attempt costs − contact costs ← headline
- Gross money recovered
- Recovery rate %
- Attempts per recovery (efficiency)
- Customer contacts per recovery (annoyance)
- Compliance violations (must be **zero**)

Fixed random seed, identical cohorts across strategies. Fair comparison of policy
quality — which is the actual claim.

We expect `naive-retry` to recover comparable *gross* and lose badly on net value
and annoyance. Reporting that honestly, including where we do not win, reads as
more credible than one triumphant number.

---

## 5. Schedule

**Day 1 — Sep 2 (today)**
- Repo, TS, vitest ✅
- Failure taxonomy from real Razorpay codes ✅
- Simulator + recovery model
- Evaluator with `do-nothing` and `naive-retry`
- *Exit: `npm run eval` prints a comparison table*

**Day 2 — Sep 3**
- Diagnose + rules policy
- Guardrails: stopping rules + compliance, with tests proving caps hold
- Ledger + replay
- LLM policy (Groq, OpenAI-compatible)
- Loss-type adapters
- *Exit: agent beats baselines on net value, zero compliance violations, full audit trail*

**Day 3 — Sep 4**
- Dashboard
- Remotion video rendered from real `results.json`
- ARCHITECTURE.md, README, public repo
- *Exit: submittable*

**Sep 5 morning** — buffer, final read-through, submit.

Scoreboard before agent: everything built after Day 1 is measurable.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Breadth kills depth | Engine first, adapters second. An adapter that isn't ready simply isn't registered. |
| Remotion rabbit hole | Eval and dashboard land first. Fallback: screen-record the dashboard. |
| Simulator looks fake | Real Razorpay reason codes; every assumption named and documented in `docs/SOURCES.md`. Never claimed as real data. |
| LLM policy flaky | Rules policy is the default. LLM is an additive mode, never a dependency. |
| Voice/TTS overrun | Hinglish *text* generation ships; TTS is explicitly a stretch. |

---

## 7. Settled decisions

- **LLM:** Groq free tier, via an OpenAI-compatible client so OpenRouter / Cerebras /
  Gemini swap in by changing a base URL. No paid services anywhere in this project.
- **Razorpay API:** no live integration. We adopt their real error taxonomy and object
  shapes instead — most of the credibility, little of the time cost.
- **Data:** synthetic, seeded, and openly documented as such.
- **Repo:** `github.com/nandhithr6/revenue-recovery-agent`, public, MIT.
