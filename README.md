# Revenue Recovery Agent

**A reason-aware, bounded AI agent that recovers failed payment revenue.**
Built for the Razorpay AI Buildathon — AI Revenue Recovery track.

---

## The problem

A customer tries to pay. The payment fails. They wanted to pay, the merchant
wanted the money, and nothing fraudulent happened — a bank blipped, a balance was
short, a card had expired. The revenue simply evaporates.

Most recovery systems chase it with a fixed retry ladder that treats every
failure identically. But **failures are not identical**, and Razorpay's own error
codes say so:

| Recovery class | Razorpay reasons | What actually works |
|---|---|---|
| `TRANSIENT_INFRA` | `bank_technical_error`, `gateway_technical_error` | Wait ~30 min for the outage to clear, then retry silently |
| `TRANSIENT_FUNDS` | `insufficient_funds`, `transaction_limit_exceeded` | Wait ~20 **hours**. Retrying sooner is wasted |
| `CUSTOMER_ACTION_REQUIRED` | `card_expired`, `invalid_vpa` | **No retry can ever work.** Nudge the customer |
| `ABANDONMENT` | `payment_cancelled`, `payment_timed_out` | Act *fast* — purchase intent decays hourly |
| `AUTH_FAILURE` | `incorrect_cvv`, `authentication_failed` | Short pause, then retry |
| `HARD_DECLINE` | `payment_risk_check_failed`, `debit_instrument_blocked` | **Stop.** Retrying harms the merchant |

Being fast costs you the patient classes. Being patient costs you the urgent
ones. No single tempo wins, which is exactly why reason-blind systems leave money
behind.

## Results

Same 500-case cohort, same seed, same guardrails, same cost model for every
strategy. The only variable is the policy.

```
Strategy                Recovered     Spent    Net value  Net after annoy.   Rate  Retries/rec  Spam  Viol.
  Do nothing                 Rs 0      Rs 0         Rs 0              Rs 0   0.0%           --     0      0
  Naive retry         Rs 2,16,490  Rs 7,713  Rs 2,08,777       Rs 2,08,777  26.6%        10.26     0      0
  Fixed dunning       Rs 2,94,904  Rs 7,151  Rs 2,87,754       Rs 2,82,454  41.2%         5.72   265      0
* Reason-aware agent  Rs 4,16,533  Rs 3,841  Rs 4,12,692       Rs 3,96,572  49.2%         2.56   806      0
```

**+₹1.14 lakh over the best baseline, using 55% fewer retries per recovery, with
zero compliance violations.**

Where the advantage comes from:

| Class | Naive retry | Fixed dunning | **Agent** |
|---|---|---|---|
| `TRANSIENT_INFRA` | 45.3% | 81.0% | **78.8%** |
| `ABANDONMENT` | 33.9% | 21.5% | **31.7%** |
| `TRANSIENT_FUNDS` | 1.7% | 38.1% | **62.7%** |
| `HARD_DECLINE` retries spent | 86 | 83 | **0** |
| `CUSTOMER_ACTION_REQUIRED` retries spent | 66 | 64 | **1** |

The baselines each win one class and lose another, because neither reads why the
payment failed. The agent is competitive across all of them and spends almost
nothing on the 150 cases where retrying provably cannot work. (The single
`CUSTOMER_ACTION_REQUIRED` attempt is deliberate: it follows a nudge that landed,
so the instrument had been fixed by then.)

### Is that just one lucky seed?

No, and this is the question worth pre-empting. `npm run eval:robust` reruns
every scenario across 50 independently seeded cohorts:

> **The agent posted the highest net value in 244 of 250 independent cohorts
> (97.6%), with zero compliance violations across every strategy and every run.**

It is not 250 of 250, and that is reported rather than tuned away. An honest
97.6% is worth more than a suspicious 100%.

### Does the answer depend on your annoyance price?

The headline metric prices customer annoyance at ₹20 a point, which is a
judgement call and the most attackable number here. So rather than defend it,
`npm run eval:sensitivity` sweeps it from ₹0 to ₹100, averaged over 15 seeds per
point:

> **Told what annoyance costs, the agent posts the highest net value at every
> price in that range, in all five scenarios.**

The ₹20 figure is an input, not a thumb on the scale. Holding the *shipped*
policy fixed while raising only the scoring price does flip the winner in the
harshest scenarios — which says something narrower and true: a policy tuned for
one price is not automatically right at another.

That sweep also caught itself being wrong once. See
[the engineering log, entry 9](docs/ENGINEERING-LOG.md).

## It also runs against the real Razorpay API

The simulator measures. The live path proves the policy runs on real rails —
same agent, same guardrails, byte for byte. There is no `if (live)` anywhere
above the execution layer.

```
live_003        ₹2,750  card_expired               CUSTOMER_ACTION_REQUIRED
         order order_TXBhFgAUP8YINN
         contact via email → plink_TXBhGds8nhhLC3  https://rzp.io/rzp/jbJHYYSJ
         defer — CONTACT_COOLDOWN
         contact via whatsapp → plink_TXBhIJ8VOCkVbB
         escalate_human

live_004          ₹899  payment_cancelled          ABANDONMENT
         contact via email → plink_TXBhKEb49j3X5Q
         stop — expected gain on Rs 899 does not justify the cost and
                intrusion of whatsapp outreach

live_005       ₹14,500  payment_risk_check_failed  HARD_DECLINE
         escalate_human
         stop — retrying cannot succeed and repeated attempts risk the
                merchant's authorisation rates
```

Those `plink_` ids are real and the URLs open: a Razorpay-hosted page reading
*"Recovery for live_003 — card_expired · INR 2,750.00"*, in test mode, created by
the agent's own decision rather than by hand.

Note what it does per case. On `card_expired` it spends **zero** retries and goes
straight to a link, because no retry can ever charge a dead card. On an ₹899 cart
it sends one email and then stops, because the expected gain does not justify a
WhatsApp message. On a fraud flag it spends **zero** retries and routes to a
human.

**What this is not: a measurement.** Five hand-driven cases cannot support a
recovery rate, and claiming otherwise would be the fastest way to lose a
technical panel. The statistics come from the seeded simulator; this shows the
same policy driving real API calls.

### A genuine decline, end to end

`npm run decline:create` makes a real payment link; pay it at Razorpay's hosted
checkout with one of their failure test cards; `npm run decline:capture` reads
the failed payment back and runs the unmodified agent on it.

What came back from the API, Razorpay-authored:

```
error_code         BAD_REQUEST_ERROR
error_description  Payment failed
error_source       gateway
error_step         payment_authorization
error_reason       payment_failed

-> taxonomy recognised it: payment_failed maps to HARD_DECLINE
-> agent decided: stop. Retrying cannot succeed and repeated attempts risk
   the merchant authorisation rates.
```

That run also found three places where our model of Razorpay came from the docs
rather than from Razorpay — including a documented test card that produces a
different error than documented, and payment links whose `payments` array omits
failed attempts entirely. See [engineering log entry 10](docs/ENGINEERING-LOG.md).

In `npm run live` the failure reasons are still seeded, because driving a browser
per case is not automatable here; every recovery *action* in that run is a real
API call.

```bash
npm run live
```

Test keys only — the runner asserts an `rzp_test_` prefix and refuses anything
else, so a live key cannot be used by accident. Credentials live in `.env`, which
is gitignored. See
[ADR 0007](docs/adr/0007-executor-split-simulator-and-live.md).

## Architecture

Full write-up: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the layers, what
each one is forbidden from doing, and why the separations sit where they do.

```
 LossEvent ──> Diagnose ──> Policy ──> Guardrails ──> Execute ──> Ledger
                              │            │                        │
                        rules or LLM   deterministic           append-only
                                       ├─ stopping rules       audit trail
                                       └─ compliance                │
                                                               Evaluator
```

### The brain proposes, the brakes decide

The policy layer only ever *returns a proposed action*. It cannot execute
anything. Every action passes through a deterministic gate, and the engine
executes only on an `allow` verdict.

This is structural, not a convention — there is no code path around it. A test
suite runs an **adversarial policy** that deliberately tries to retry infinitely
and voice-call at 3am on repeat. It cannot. That matters most when an LLM writes
the policy: a prompt-injected or simply wrong model still cannot breach a limit.

### Compliance defers, it does not drop

Verdicts are three-valued. A message that would land at 21:30 is not discarded —
it is **queued for 09:00 the next morning**. Straight from the audit ledger:

```json
{
  "caseId": "loss_00403",
  "actionKind": "contact_customer",
  "channel": "email",
  "outcome": "deferred",
  "rule": "QUIET_HOURS",
  "explanation": "Contact would land at 00:01 local, inside quiet hours (21:00-09:00). Deferred to the next permitted window rather than dropped.",
  "deferredTo": 1788233400000
}
```

Timing rules (quiet hours, cooldowns, caps) **defer**, because waiting fixes
them. Permission rules (DND, missing consent) **block**, because waiting never
will. Conflating the two either throws away revenue or queues up violations.

Rules enforced: quiet hours 21:00–09:00 local, TRAI DND (scoped to SMS and voice,
which is what the regulation actually covers), per-channel consent, daily and
weekly contact caps, inter-contact cooldowns, retry caps and cooldowns, case-age
limits, and a global kill switch.

### Annoyance is a currency

Rupee cost cannot constrain a recovery agent: return on spend runs 109x–530x, so
the money-optimal policy is "contact everyone on the loudest channel". That wins
the benchmark and loses the merchant.

So annoyance is priced — ₹20 per point, email 1 / SMS 5 / WhatsApp 5 / voice 10 —
and folded into the headline metric. Restraint then falls out of the same
arithmetic as everything else, and **intrusiveness scales with the money at
stake**: a ₹400 abandoned cart earns an email, a ₹50,000 receivable earns a
WhatsApp message. See [ADR 0004](docs/adr/0004-price-annoyance-as-a-currency.md).

## Where we chose *not* to use an LLM

An LLM sits in exactly one place: proposing an action for a case. Everything
load-bearing is deterministic.

| Component | Implementation | Why |
|---|---|---|
| Compliance rules | Deterministic | Legal constraints. A system that respects them 99.7% of the time breaks the law twice a week |
| Stopping rules | Deterministic | Asking the thing being bounded to enforce its own bound is not a control |
| Failure classification | Lookup table | 21 documented strings → 6 classes is a dictionary, not an inference problem |
| Retry timing | Fixed per-class schedules | "Why did you retry at 20 hours?" deserves a rule, not a sample |
| Novel/ambiguous cases | **LLM** | Genuinely open-ended input, where the alternative is giving up |

When the LLM policy is enabled, its output is validated against a Zod schema
before it can reach the guardrails — markdown fences stripped, chatty preambles
discarded, invented actions and out-of-range delays rejected. Anything that fails
validation falls back to the deterministic agent. **The system runs identically
with the network unplugged.** Full reasoning in
[ADR 0003](docs/adr/0003-where-we-chose-not-to-use-an-llm.md).

### And we measured it, rather than assuming

That argument was made from first principles. It now has a number behind it, on
the same cohort, with the LLM policy actually deciding:

| | Rules agent | LLM agent |
|---|---|---|
| Net after annoyance | **₹3,96,572** | ₹3,39,628 |
| Recovery rate | **49.2%** | 47.4% |
| Retries per recovery | **2.56** | 2.91 |
| Annoyance points | **806** | 1,225 |
| Compliance violations | 0 | **0** |

**The LLM is worse on every axis, and worst on restraint** — 52% more customer
annoyance for less recovered revenue. It reaches for a message where the rules
agent has already worked out that the expected value does not justify one.

Two things worth drawing out. The zero in that last column is ADR 0002 doing its
job: the guardrails hold identically whichever policy proposes the action. And an
earlier run appeared to show the *opposite* result — rate limits meant only 90 of
203 decisions were cached, so the policy fell back to rules for more than half
its cases and we were crediting the model for the rules agent's work. That
mistake is written up in [engineering log entry 11](docs/ENGINEERING-LOG.md)
rather than quietly replaced.

The LLM arm stays in the repo, for reason codes the taxonomy has no entry for and
as evidence the layering is real. It does not go on the critical path of a
decision a lookup table makes better and for free.

## Honesty about the data

**All data here is synthetic, and we say so first rather than waiting to be
asked.**

- **Real:** every failure `reason` code, taken from Razorpay's published card and
  UPI error documentation. Cards *and* UPI, because UPI is how India actually
  pays.
- **Grounded, not measured:** the shape of the failure mix. NPCI's own UPI
  operating targets (Circular OC-149) put technical/infrastructure declines
  below 1% and customer-side declines below 5% of all transactions —
  business-side failures dominate technical ones by design. Our baseline mix
  lands at 23.3% technical / 76.7% customer-side, the same direction,
  independently arrived at before we found that circular. The exact weight of
  each individual reason inside that split is still ours.
- **Ours:** the mapping from reason to recovery class, the recovery-probability
  curves, the cost model, and the exact per-reason weights. Each is a named,
  commented constant with its reasoning attached.

These results demonstrate **policy quality** on identical seeded cohorts. They
are not a prediction of production rupees, and anyone claiming that from
simulated data would be overselling. See [docs/SOURCES.md](docs/SOURCES.md).

The agent also never reads the simulator's ground truth — a test enforces the
import boundary, because an agent grading its own exam proves nothing
([ADR 0005](docs/adr/0005-the-agent-must-not-read-ground-truth.md)).

## What broke

[docs/ENGINEERING-LOG.md](docs/ENGINEERING-LOG.md) is the honest account. The
short version:

1. **A guardrail accidentally made the baseline twice as good.** The retry
   cooldown gave naive retry the patience it lacked, doubling its net value. We
   kept it and raised our own bar rather than exempting the baselines.
2. **The agent first won by being annoying** — 1,101 spam points to dunning's
   212. Fixed by pricing annoyance, after establishing that no honest *rupee*
   cost model could ever have caught it.
3. **Every message was overvalued 3–5×.** A real bug: contacts were priced using
   the odds a *retry* succeeds, ignoring whether the nudge lands at all. Two
   failing tests found it.
4. **DND was over-blocking.** TRAI's registry covers telecom, not email. Being
   over-strict on compliance is just a different way of being wrong, and it costs
   the merchant money.
5. **The agent does not win everywhere.** Fixed dunning beats it on
   `bank-outage`, where a pure infrastructure failure rewards patience over
   diagnosis. Documented rather than tuned away — a strategy tuned until it wins
   all five hand-written scenarios is a strategy overfitted to five hand-written
   scenarios.

## Running it

```bash
npm install
npm run eval
```

Other scenarios:

```bash
npm run eval -- bank-outage
```

`baseline-week` · `bank-outage` · `month-end-squeeze` · `risk-spike` ·
`stale-instruments`

The two checks that make the headline defensible — 50 seeded cohorts per
scenario, and the annoyance-price sweep:

```bash
npm run eval:robust
```

```bash
npm run eval:sensitivity
```

Tests (118, including an adversarial policy that cannot breach any limit, the
kill switch, and the loss-type layer):

```bash
npm test
```

The dashboard reads the bundle `eval:all` writes and never simulates anything
itself, so there is no second source of truth:

```bash
npm run eval:all && npm run dashboard
```

Optional LLM policy — free tiers only, no paid service anywhere in this project:

```bash
LLM_API_KEY=your_groq_key npm run eval
```

Works with Groq, OpenRouter, Cerebras or anything else speaking the
OpenAI-compatible API; set `LLM_PROVIDER` or `LLM_BASE_URL` to switch.

## Repo map

```
src/
  domain/      failure taxonomy (real Razorpay codes), core types
  sim/         seeded generator, recovery model, scenarios
  policies/    baselines, reason-aware agent, LLM agent, playbooks
  guardrails/  compliance, stopping rules, the gate
  ledger/      append-only audit trail
  llm/         provider-agnostic client, schema validation
  eval/        engine, metrics, report, CLI
docs/
  adr/         six architecture decision records
  SOURCES.md   what is real, what is assumed
  ENGINEERING-LOG.md
  PAYMENTS-PRIMER.md
```

## Why this track

Revenue recovery gives an indisputable answer: the money either arrived or it did
not. Fraud detection cannot offer that — you can never prove the fraud you
prevented would have happened, so every metric rests on labels you assigned
yourself.

Razorpay asked for *measured money recovered across a batch, with compliant
escalation, stopping rules, and an audit trail*. This is that, and each of the
four is a file you can open.
