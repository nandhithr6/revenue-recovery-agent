# Phase 2 plan — rigour, then a dashboard that shows its working

Written 2 Sept 2026. Submission due 5 Sept. Resume from here.

Phase 1 (done): taxonomy, simulator, engine, guardrails, ledger, reason-aware
agent, loss-type adapters, LLM policy, 92 tests, six ADRs, engineering log,
README, first dashboard.

---

## The two problems this phase fixes

**1. Every result is a single random draw.** One seed per scenario. A reviewer
asks "did you get lucky?" and today the honest answer is "possibly".

**2. The dashboard asks to be believed.** It shows aggregate charts and no
evidence. A reader cannot see the input data, cannot watch the agent decide, and
has no way to tell our numbers from hardcoded ones. Nandhitha's words, and they
are correct: *"we don't even know whether that agent is working or not. Is it
hard coded, or what?"*

Fixing (2) is worth more than any new feature. A submission that proves it works
beats one that claims more.

---

# Part A — Robustness (highest value in the repo)

**Goal:** replace "the agent won" with "the agent won 30 times out of 30".

- New `src/eval/robustness.ts`
- Run every scenario across **N = 30 seeds** (seed offset per run; cohort AND
  engine RNG both reseeded, or the variance is fake)
- Per strategy report: mean, median, p10, p90, min, max of
  `netValueAfterAnnoyancePaise`, and **win rate** against each baseline
- Write `out/robustness.json`
- CLI table + a new dashboard section
- `npm run eval:robust`

**The claim we want to be able to make:** "across 150 independent cohorts, the
agent posted the highest net value in X of them." If X < 150, say so — a 94%
win rate honestly reported is stronger than a suspicious 100%.

**Watch out:** runtime. 30 seeds x 5 scenarios x 4 strategies x 500 cases.
Measure it; drop cohort size for the robustness run if it exceeds ~30s.

---

# Part B — Sensitivity of the annoyance price

**Goal:** stop asserting ₹20 and start showing what it does.

- New `src/eval/sensitivity.ts`
- Sweep `SPAM_POINT_PRICE_PAISE` from ₹0 to ₹100 in ~11 steps
- At each price, recompute `netValueAfterAnnoyance` for every strategy and record
  the ranking
- Find and report the **flip point**: the price at which the winner changes, or
  state plainly that there is none in range
- Write `out/sensitivity.json`; chart it on the dashboard

**Why it matters:** ₹20 is our most attackable number. If the agent wins at every
price from 0 to 100, the attack disappears. That is a 20-minute build that
removes the single best question a panel could ask.

Requires threading the price as a parameter rather than a module constant — small
refactor in `metrics.ts` and `playbook.ts`.

---

# Part C — Tests for the loss-type layer

Currently **zero** tests mention `loss-profiles`, `subscription`, `receivable` or
`checkout_abandonment`. This is the newest, most intricate code, and it is the
code that already broke everything once.

New `src/policies/loss-profiles.test.ts`:

- Checkout abandonment: agent spends **0** retries; recovery only via contact
- Receivable: **0** retries; promise-to-pay honoured inside the window, chased
  the moment it lapses; a landed contact does not trigger a second chase early
- Subscription mandate: more retries than a plain payment failure, spaced longer,
  and **every scheduled offset lands inside the case-age limit** (this exact bug
  shipped once)
- Payment failure: unchanged baseline behaviour
- Engine-level: `retry_payment` on a link-recoverable loss type has probability
  zero **for every strategy**, not just the agent

---

# Part D — Kill switch and safety tests

Advertised in the README, **zero** tests today.

New cases in `guardrails.test.ts`:

- `killSwitch: true` blocks every action kind, for every strategy
- With the switch on, an entire cohort recovers ₹0 and spends ₹0
- Every blocked action still reaches the ledger with rule `KILL_SWITCH`
- Terminal rules (`CASE_AGE_LIMIT`, `KILL_SWITCH`, `MAX_HUMAN_ESCALATIONS`) close
  a case rather than being re-proposed — regression test for the 29-identical-
  blocks bug

---

# Part E — Dashboard v2: show the working

The current dashboard reports conclusions. It must instead let a reader
**inspect the evidence**. Five new sections, roughly in priority order.

## E1. The data itself

A real table of loss events, not a summary. Columns: id, amount, method
(UPI/card), Razorpay `reason` code, recovery class, loss type, timestamp.
Filterable by class and method, sortable, ~40 rows visible with the rest paged.

> Answers: *what is this system actually looking at?*

## E2. Watch the agent decide ← the section that fixes the trust problem

Pick any case. Step through its decisions one at a time. For each step show
three panels side by side:

```
   WHAT THE AGENT SEES        WHAT IT DECIDED         WHAT THE GUARDRAIL SAID
   reason: insufficient_funds  retry_payment          allow
   amount: ₹1,240              in +20h                (limits ok, no contact)
   method: upi                 "TRANSIENT_FUNDS:      
   retries so far: 0            needs a top-up,       -> executed, failed
   contacts so far: 0           retrying inside the
   channels: email, whatsapp    hour wastes an
   hours since failure: 0       attempt"
```

The left panel is literally `CaseContext` — the exact inputs, nothing hidden. The
middle is the returned `Action` with its verbatim rationale. The right is the
guardrail verdict.

> Answers: *is this hardcoded?* No — here is the input, the rule that fired, and
> the output, for any case you pick.

Needs per-case traces exported (see F below).

## E3. Same case, four strategies

The most convincing single view in the whole submission. One case, four columns,
what each strategy did with it. On an expired card: naive retry burns three
attempts and fails; fixed dunning burns three and fails; the agent spends zero
and sends one email that works.

> Answers: *what is actually different about your agent?*

## E4. The playbook, in the open

Render `PLAYBOOKS` and `LOSS_PROFILES` as tables straight from the bundle — retry
offsets, channel ladders, and the written reasoning for each class. Nothing about
the policy should be buried in source.

> Answers: *what are its actual rules?*

## E5. Provenance — real vs assumed

A two-column panel making the honesty line visible rather than a footnote:

| From Razorpay's docs | Our assumption |
|---|---|
| 21 failure reason codes (card + UPI) | recovery-probability curves |
| error structure and sources | cost model, annoyance price |
| documented next steps | failure mix per scenario |

With links to the Razorpay pages.

> Answers: *how much of this did you make up?* — asked and answered before anyone
> has to.

## E6. Explain the simulation in plain words

A short "how this works" block near the top: 500 synthetic payments → agent reads
the reason → picks an action → guardrails allow/defer/block → ledger records it →
scoreboard compares. Four sentences and a diagram. Nobody should reach section 3
still wondering what they are looking at.

## Design notes for v2

- Keep the ledger direction: ruled rows, tabular figures, Zilla Slab + IBM Plex.
- Keep the timing ribbon as the hero.
- **Add a persistent sticky nav**, since the page is now long.
- Every section gets a one-line plain-English subtitle. No jargon without a gloss
  on the same screen.
- Verify with DOM queries, not screenshots — the preview pane's screenshots time
  out on this page.

---

# Part F — Export per-case traces

E2 and E3 need data the bundle does not carry yet.

In `run-all.ts`, export a **sample of ~60 cases** with, for each: the full
`LossEvent`, and for every strategy the ordered list of
`(CaseContext-at-decision, Action, Verdict, outcome)`.

Choose the sample deliberately, not randomly — at least a few of each recovery
class and each loss type, and include the cases where the strategies diverge most
sharply, since those are the interesting ones.

Size check: keep the bundle under ~2 MB or the dashboard load gets slow. Trim
`CaseContext.history` to counts rather than full arrays if needed.

This requires the engine to optionally record decision inputs — add a `trace?:
TraceSink` parameter to `runCase`, off by default so the hot path stays clean.

---

# Part G — Smaller items

- **Hinglish message generation.** Razorpay lists it as a direction. Generate the
  actual message body per channel via the LLM, with a deterministic template
  fallback. Show real examples on the dashboard. *Stretch — a feature, not
  rigour.*
- **Run the LLM policy once for real** against Groq and record the result. It is
  schema-tested but has never met a live model, and it is not in `eval:all`.
  Add `llm-agent.test.ts` for cache hit/miss and fallback with no key.
- **UPI vs card breakdown.** We simulate the mix and never report on it. India-
  specific angle currently left on the table.
- **Dead code:** `CHASE_INTERVAL_MS`, `ABANDONMENT_REENGAGE_MS` exported and
  unused; `expectedGainPaise` / `worthSpending` superseded by `worthContacting`.

---

# Explicitly out of scope — say so in the README

Naming these is worth more than half-building them:

- Partial payments and partial recovery
- Refunds and chargebacks (that is the Risk track)
- Multi-currency; per-merchant policy differences
- **Customer churn** — annoyance is priced, but customers never actually leave
- Live Razorpay API integration

---

# Order of work when resuming

1. **C + D** — tests first. Fast, and they protect everything after.
2. **A** — robustness. The strongest claim in the submission.
3. **B** — sensitivity. Removes the best question a panel could ask.
4. **F** — per-case traces, since E2/E3 depend on them.
5. **E** — dashboard v2.
6. **G** — only if time remains.

Then the Remotion video, then push to `github.com/nandhithr6/revenue-recovery-agent`.

**Commit messages carry no co-author trailer.**

---

# Part H — Live Razorpay integration (decided: yes)

Phase 1 chose pure simulation and ADR 0001 recorded that. **That decision is now
partly reversed.** Research into test mode found it offers more than assumed, and
the added credibility is worth the time.

## What test mode actually gives us

**Test cards that trigger specific failures on demand.** This is the valuable
part, and it was the thing worth checking before deciding:

| Error code | Visa test card | Mastercard test card |
|---|---|---|
| `payment_timed_out` | 4100 2800 0009 0000 | 5305 6200 0006 0000 |
| `insufficient_fund` | 4100 2800 0008 0001 | 5305 6200 0005 0001 |
| `payment_cancelled` | 4100 2800 0007 0002 | 5305 6200 0004 0002 |
| `gateway_technical_error` | 4100 2800 0002 0007 | 5305 6200 0009 0007 |
| `authentication_failed` | 4100 2800 0000 0009 | 5305 6200 0007 0009 |
| `card_disabled_for_online_payments` | 4100 2800 0003 0006 | 5305 6200 0000 0006 |
| `card_declined` | several variants | several variants |

Also available: **Payment Links API** (30 per business in test mode), **webhooks**
including `payment.failed`, and Orders/Payments/Customers/Subscriptions.

Note the discrepancy to verify: the test-card page says `insufficient_fund`
(singular) while the error-code page says `insufficient_funds`. Confirm against a
real response and fix the taxonomy if needed — finding that ourselves would be a
good detail to mention.

## The architecture: an executor split, not a rewrite

**Nothing about the agent or the guardrails changes.** Introduce an interface at
the only point that touches the outside world:

```
Agent (unchanged) -> Guardrails (unchanged) -> Executor -> Ledger (unchanged)
                                                  |
                                    +-------------+-------------+
                                    |                           |
                            SimulatedExecutor          RazorpayExecutor
                            (seeded, 500 cases,        (live test mode,
                             reproducible)              real API responses)
```

- `src/execution/executor.ts` — the interface: `retryPayment`, `contactCustomer`,
  `escalateHuman`, each returning an outcome.
- `src/execution/simulated.ts` — lift the current engine execution into it.
- `src/execution/razorpay.ts` — the live one.

**Why this is the right shape:** the same agent, byte for byte, runs against both.
That is a much stronger claim than either alone, and it turns the executor split
into evidence that the layering was correct rather than a design assertion.

## What the live path does

1. **Create an Order** via the Orders API.
2. **Drive a failing payment** with a chosen test card, capturing the real error
   response: `code`, `description`, `source`, `step`, `reason`, `metadata`.
3. **Feed that real failure to the unmodified agent**, which classifies it from
   the real `reason` string and picks an action.
4. **Execute the action for real:**
   - `contact_customer` -> create an actual **Razorpay Payment Link** and record
     its URL in the ledger. This is a genuine recovery mechanism, not a mock.
   - `retry_payment` -> create a fresh Order and attempt it again.
5. **Ledger the whole thing** exactly as the simulator does.

Output `out/live-run.json` plus ledger entries carrying real Razorpay ids
(`order_...`, `pay_...`, `plink_...`). Those ids are the proof.

## Division of labour: simulator vs live

State this plainly in the README, because it is the honest and the strongest
framing:

| | Simulator | Live test mode |
|---|---|---|
| Purpose | **Measurement** | **Proof it runs on real rails** |
| Volume | 500 cases x 5 scenarios x 30 seeds | a handful of cases |
| Reproducible | yes, seeded | no |
| Money | none, modelled | none, test mode |
| What it proves | the policy is better | the policy works against the real API |

Neither alone is enough. Statistical claims need the simulator; credibility needs
the live path. Do not let the live run pretend to be a measurement — a dozen
hand-driven payments prove nothing about recovery rates, and claiming otherwise
is the fastest way to lose a panel.

## Safety rules (non-negotiable)

- **Test keys only.** Assert the key starts with `rzp_test_` and refuse to run
  otherwise. A live key must be impossible to use by accident.
- **Keys in `.env`, which is already gitignored.** Never committed, never logged,
  never printed in output or screenshots.
- `.env.example` documents the variable names with empty values.
- The live path is **opt-in**: `npm run live` only. `npm run eval`, `eval:all`
  and the tests never touch the network.
- Rate limits: sequential calls, small delays, and stop on the first 4xx.

## What Nandhitha needs to do

1. Sign up at <https://dashboard.razorpay.com/signup> (no business verification
   is needed for test mode).
2. Settings -> API Keys -> **switch to Test Mode** -> Generate Test Key.
3. Put them in `.env`:
   ```
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
   RAZORPAY_KEY_SECRET=xxxxxxxx
   ```
4. Do not paste the secret into chat. Only the file.

## Deliverables

- `src/execution/` with the interface and both executors
- `npm run live` — drives a few real failures end to end
- `out/live-run.json` with real Razorpay ids
- A dashboard section showing the live run beside the simulated one
- ADR 0007 recording the executor split; ADR 0001 amended, not deleted
- README section on the simulator/live division of labour

## Honest note on sequencing

This is real work sitting alongside Parts A, B, E and F plus the video, with
three days left. If time runs short, the order that preserves the most value is:

**A and B first** (they make every existing claim defensible), **then a minimal
live path** — even a single real failure, correctly classified by the unmodified
agent, with a real Payment Link created, is worth most of the credibility of a
full integration. Breadth of live coverage matters far less than the fact that it
runs at all.
