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
  Reason-aware agent  Rs 4,10,753  Rs 4,072  Rs 4,06,681       Rs 3,88,921  49.6%         2.50   888      0
* Adaptive agent      Rs 5,55,601  Rs 3,536  Rs 5,52,066       Rs 5,35,786  59.8%         2.31   814      0
```

Two agents, not one. `agent-rules` classifies the failure and follows a
per-class playbook — a real improvement over a fixed schedule, but still a
lookup table underneath. `agent-adaptive` instead assesses the case (known /
inferred / unknown, with a confidence band — see
[ADR 0009](docs/adr/0009-unknown-case-handling-and-voice.md)), prices a short
list of candidate actions in rupees against its own belief curves — including
voice, priced on the same footing as email/SMS/WhatsApp — and takes whichever
clears the highest expected value, so amount, elapsed time, attempt count and
evidence quality all move the answer. Both agents are measured against the
baselines and against each other on identical cohorts; nothing about the
comparison is rigged toward either.

**Adaptive agent: +₹2.53 lakh over the best baseline (fixed dunning) — a 90%
lift — using 60% fewer retries per recovery, with zero compliance
violations. Efficiency: ₹157.14 recovered per ₹1 spent, against fixed
dunning's ₹41.24. The trade is explicit, not hidden: fixed dunning is
quieter per case it recovers (1.29 annoyance points per recovery vs.
adaptive's 2.72), adaptive is far more money-efficient. Net value after
annoyance already prices that trade in; it is not free.**

Where the advantage comes from:

| Class | Naive retry | Fixed dunning | Reason-aware agent | **Adaptive agent** |
|---|---|---|---|---|
| `TRANSIENT_INFRA` | 45.3% | 81.0% | 81.8% | **87.6%** |
| `TRANSIENT_FUNDS` | 1.7% | 38.1% | 61.9% | **79.7%** |
| `ABANDONMENT` | 33.9% | 21.5% | 30.1% | **40.3%** |
| `HARD_DECLINE` retries spent | 86 | 83 | 0 | **0** |
| `CUSTOMER_ACTION_REQUIRED` retries spent | 66 | 64 | 2 | **4** |

The baselines each win one class and lose another, because neither reads why
the payment failed. Both agents spend almost nothing on the classes where
retrying provably cannot work; the adaptive agent additionally out-recovers
the schedule-based agent on every class where amount and timing actually
matter, because it is the only one of the four that can see either.
`CUSTOMER_ACTION_REQUIRED` is a deliberate, small exception: 4 retries
(never against the dead instrument itself — always a genuine, unlocked
retry after a nudge landed) is the honest cost of a real fix, made after
this project's own audit found and fixed a boundary bug where the agent
priced a nudge's payoff at literal elapsed=0 and gave up on some of these
cases entirely (see [engineering log, entry 15](docs/ENGINEERING-LOG.md)).

### Is that just one lucky seed?

No, and this is the question worth pre-empting. `npm run eval:robust` reruns
every scenario across 50 independently seeded cohorts, for both agents at once:

> **One of our two strategies posted the highest net value in 249 of 250
> independent cohorts (99.6%) — the adaptive agent alone in 203 (81.2%), the
> reason-aware agent alone in 46 (18.4%) — with zero compliance violations
> across every strategy and every run.**

It is not 250 of 250, and that is reported rather than tuned away. An honest
99.6% is worth more than a suspicious 100%; the one loss goes to a baseline in
a single cohort and stays in the numbers.

### Does the answer depend on your annoyance price?

The headline metric prices customer annoyance at ₹20 a point, which is a
judgement call and the most attackable number here. So rather than defend it,
`npm run eval:sensitivity` sweeps it from ₹0 to ₹100, averaged over 15 seeds per
point, for both agents:

> **Told what annoyance costs, the adaptive agent posts the highest net value
> at every price from ₹0 to ₹100, in all 5 scenarios — no exceptions.**

The ₹20 figure is an input, not a thumb on the scale: rebuilding the agent at
each price rather than holding one number fixed is what makes that a clean
sweep instead of a coincidence. A strategy that wins at every price only
because the sweep never rebuilds it would be a different, weaker claim.

That sweep also caught itself being wrong once. See
[the engineering log, entry 9](docs/ENGINEERING-LOG.md). The full story of how
the adaptive agent came to exist — a bug that made a fixed schedule look better
than it should have, and what we built after fixing it — is entry 12. Entry 13
is a follow-up audit finding and fixing a second, smaller version of the same
kind of defect in the agent's human-escalation pricing.

## What happens when the case isn't one of the six classes

Every result above assumes a documented Razorpay reason code. Real intake
eventually won't be: a code added next quarter, a malformed field, a case
whose own bookkeeping doesn't add up. `agent-adaptive` now assesses every
case first — `known` / `inferred` / `unknown`, with a `high` / `medium` /
`low` confidence band, computed only from what the agent can actually see —
before it prices a single candidate. **The agent becomes more conservative as
evidence gets thinner, never more reckless**: an unrecognised reason code
never gets an automatic retry (retrying a misclassified failure risks real
issuer penalties, the exact harm [entry 8](docs/ENGINEERING-LOG.md) argued
against), is offered at most one cheap contact channel, and — above a value
floor — an honestly-labelled "route to human review" escalation rather than
one dressed up as a recovery channel. A deterministic fuzzy-matcher (token
overlap against the 34 documented codes) can infer a plausible class at
medium confidence; an optional LLM can plug into the identical seam and is
hard-capped at the same medium confidence regardless of what it claims — see
[ADR 0009](docs/adr/0009-unknown-case-handling-and-voice.md). Neither can
ever promote a guess to "known."

This is measured separately from the financial benchmark, on purpose: a
genuinely unknown case has no ground-truth recovery curve to score against
(`sim/recovery-model.ts` only has entries for the six documented classes), so
inventing a ₹ figure for it would be dishonest. `npm run eval:novelty` runs
12 hand-authored adversarial cases — unknown codes, malformed context,
contradictory bookkeeping, amounts and combinations none of the five real
scenarios ever produce — and checks safe behaviour instead: zero automatic
retries on unrecognised failures, zero compliance violations, appropriate
escalation. Currently 12/12 safe; one of those 12 was a real bug the suite
itself caught (an inferred, fuzzy-matched class was being retried as freely
as a documented one — fixed the same day, see engineering log entry 14).

**Voice is now a real, priced recovery channel**, not a demo prop. Its cost
(₹15), its annoyance price (10 points — five times a WhatsApp message) and
its believed landing odds were already in the codebase; the only gap was
that the candidate menu never offered it. It now competes honestly against
every other channel and only wins the argmax when its higher landing odds
are worth its higher price. Uniquely among channels, a voice call that
connects produces a *structured* outcome — a commitment to pay, a fixed
instrument, a dispute, a refusal, no answer — instead of a plain
succeeded/failed boolean, and the agent's very next decision reacts to it:
a commitment defers the case and rechecks once the window lapses (reusing
the same mechanism already built for receivable promises); a dispute or
refusal ends the case rather than trying harder; a non-connect changes
nothing. The dashboard's "Watch the agent work" hero features one real,
naturally-occurring case showing the full chain — found by searching the
actual cohort output, not scripted.

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
                       rules, EV or LLM deterministic         append-only
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
| Failure classification | Lookup table | 34 documented strings → 6 classes is a dictionary, not an inference problem |
| Retry timing | Fixed per-class schedules | "Why did you retry at 20 hours?" deserves a rule, not a sample |
| Novel/ambiguous cases | **LLM** | Genuinely open-ended input, where the alternative is giving up |

When the LLM policy is enabled, its output is validated against a Zod schema
before it can reach the guardrails — markdown fences stripped, chatty preambles
discarded, invented actions and out-of-range delays rejected. Anything that fails
validation falls back to the deterministic agent. **The system runs identically
with the network unplugged.** Full reasoning in
[ADR 0003](docs/adr/0003-where-we-chose-not-to-use-an-llm.md).

That table's last row (`agent-llm`, an LLM proposing the *action*) is a
different, narrower thing from the optional LLM interpretation added for
unknown reason codes (`src/llm/unknown-error.ts`, [ADR
0009](docs/adr/0009-unknown-case-handling-and-voice.md)). The new one cannot
select an action, price a candidate, execute anything, or exceed medium
confidence — it can only feed a class guess into `CaseAssessment`, in the
exact same seam a deterministic fuzzy-matcher already fills when no LLM is
configured. The measured finding below (LLM-as-policy loses on every axis)
is the reason that seam is scoped as narrowly as it is, not a reason to
avoid it entirely.

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
  business-side failures dominate technical ones by design. Restricted to the
  two failure classes that framework actually covers (abandonment and hard
  declines fall outside it), our baseline mix lands at 36.2% technical / 63.8%
  customer-side — same direction, independently arrived at before we found that
  circular, though less skewed than NPCI's real ~5-to-1. We say so rather than
  adjusting the numbers to close the gap. The exact weight of
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
5. **Neither agent wins everywhere.** Across 250 independently seeded cohorts,
   one baseline takes a single run outright (249/250, not 250/250), and the
   annoyance-price sweep hands two of five scenarios to the reason-aware agent
   at the high end of the price range. Documented rather than tuned away — a
   strategy that wins every run and every price is a strategy overfitted to
   the runs and prices you happened to write.
6. **`STOP` was quietly doing the job of `WAIT`.** A receivable with an
   unbroken promise-to-pay was being closed forever the moment the promise was
   made, because the only "pause" primitive available was the same one used
   for "this case is truly finished." Fixed dunning was beating the agent on
   exactly these cases. Added a genuine `wait` action, then went further:
   built a second agent (`agent-adaptive`) that prices candidate actions in
   rupees instead of consulting a schedule at all. Full story in
   [engineering log, entry 12](docs/ENGINEERING-LOG.md).

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

A third, deliberately separate check — safe behaviour on unknown/adversarial
cases, never blended with the ₹ numbers above:

```bash
npm run eval:novelty
```

Tests (219, including an adversarial policy that cannot breach any limit, the
kill switch, the loss-type layer, and a boundary suite that checks every new
policy file for a ground-truth import the same way the original two were
checked):

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
