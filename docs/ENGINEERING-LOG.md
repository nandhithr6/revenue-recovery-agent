# Engineering log — what broke, and what we did about it

Razorpay asks for "what broke, and what you did about it." This is that, written
as it happened rather than reconstructed afterwards. Every entry is a real
problem found in this build, most of them by tests or by reading output that did
not look right.

---

## 1. The guardrail that accidentally made the dumb baseline better

**What happened.** We added the retry cooldown — a 15-minute minimum gap between
payment attempts — as a safety rule. Then the scoreboard moved in a direction we
did not expect:

| | Before cooldown | After |
|---|---|---|
| Naive retry, `TRANSIENT_INFRA` recovery | 22.6% | **48.2%** |
| Naive retry, net value | ₹3.55L | **₹7.27L** |

The safety rail had doubled the performance of the strategy we were trying to
beat. Naive retry's whole problem was hammering a bank that was still down; by
forcing a gap between attempts, we had accidentally given it the patience it
lacked.

**The temptation.** Exempt the baselines from the cooldown so our numbers looked
better.

**What we did.** Kept it, and treated it as a finding. Applying different rules
to the baseline than to the agent would make the comparison meaningless, and it
is the kind of thing a panel finds in thirty seconds. It also raised the bar
honestly: the agent now has to beat a baseline that safety rails have already
improved.

**What it taught us.** Guardrails are not only a compliance tax. Sometimes the
constraint *is* the strategy.

---

## 2. The agent won by being annoying

**What happened.** First working version of the reason-aware agent. It won on net
value — and posted **1,101 spam points against fixed dunning's 212**. Per rupee
recovered it was over four times noisier than the baseline it beat.

**Root cause.** We had put WhatsApp first on the abandonment ladder, reasoning
that abandonment is time-sensitive so the higher-impact channel is worth it.
Abandonment is the largest class in the cohort (186 of 500 cases), and WhatsApp
carries five annoyance points to email's one. The agent was buying its win with
the merchant's customer relationships.

**The deeper problem.** Rupee cost could never have caught this. At a median
ticket of ~₹850 against message costs measured in paise, recovery outweighs spend
by two orders of magnitude — the rupee-optimal policy really is "contact everyone
on the loudest channel". Optimising the money alone produces a system that wins
the benchmark and loses the merchant.

**The fix.** Gave annoyance an exchange rate: `SPAM_POINT_PRICE_PAISE = 2000`
(₹20 per point), folded into the same expected-value arithmetic as everything
else. Restraint stopped being a special case and became a consequence of the
maths. Ladders reordered cheapest-first, and how far up the agent is willing to
climb now scales with the amount at stake.

Spam fell 1,101 → 705 and recovery *rose* ₹8.03L → ₹9.16L, because the agent
stopped wasting expensive channels on cases too small to justify them.

**Also changed:** the scoreboard now reports `net value after annoyance` as the
headline. Two separate columns let a reader pick whichever favours their
conclusion; one number forces the trade to be made explicitly, at a stated rate.

---

## 3. The agent was overvaluing every message by 3–5×

**What happened.** Two tests failed after the annoyance fix: a ₹400 abandoned
cart was still escalating to SMS, and the "climbs to a louder channel for bigger
amounts" test found no difference between a ₹400 case and a ₹50,000 one.

**Root cause.** A genuine modelling error. The agent priced a *contact* using
`believedPeakOdds` — the probability that a **retry** succeeds. For an expired
card that is 0.8. But a message only pays off if two things happen: the customer
has to act on it *and* the resulting retry has to work. We were pricing the
second gamble and ignoring the first, inflating the value of every message by
roughly three to five times.

**The fix.** `expectedContactGainPaise` — amount × P(nudge lands) × P(retry then
succeeds), with the agent carrying its own believed nudge-effectiveness figures
per channel.

**What it taught us.** The tests were not being fussy. "This ₹400 cart should not
earn an SMS" was a product intuition, and following it down found real broken
arithmetic underneath.

---

## 4. Do-not-disturb was blocking too much

**What happened.** `DND_REGISTERED` fired 245 times and was blocking *every*
channel, email included.

**Why it was wrong.** TRAI's DND registry is telecom regulation: it governs
commercial calls and SMS. Email and WhatsApp sit outside it and are governed by
per-channel consent instead. Blanket-blocking was simpler, but it was not what
the rule says, and it forfeited recoverable revenue on channels the customer had
explicitly opted into.

**The fix.** Scoped DND to `['sms', 'voice']`. Tests now assert both halves —
telecom blocked, consent-based channels still available.

**What it taught us.** Being over-strict on compliance is not the safe default.
It is just a different way of being wrong, and it costs the merchant money.

---

## 5. The agent does not win everywhere, and we did not hide it

**What happened.** A test asserting the agent beats every baseline on every
scenario failed on `bank-outage`: fixed dunning scored ₹12,33,344 against the
agent's ₹11,96,745.

**Why.** That scenario is 61% transient infrastructure, where a patient
+1h/+24h/+72h ladder is already near-optimal. Reason-awareness buys almost
nothing when nearly every case wants the same treatment — while the agent still
spends annoyance on the other 39%.

**The temptation.** Tune the infra playbook until the agent won, and ship five
green scenarios.

**What we did.** Left it. A strategy tuned until it wins all five hand-written
scenarios is a strategy overfitted to five hand-written scenarios. Instead the
test suite now asserts the agent wins **on aggregate**, and separately asserts
that it loses *only* where we have documented that it loses — so a new loss
becomes a finding to explain rather than a number to quietly re-baseline.

**The honest claim:** reason-awareness pays when the failure mix is varied. In a
monolithic outage, a simple patient schedule is genuinely competitive, and
saying so is worth more than a fifth green tick.

**Postscript.** This loss later disappeared — but not because we tuned the agent.
See entries 7 and 8.

---

## 6. Smaller things

- **Money as floats.** Rejected early. All currency is integer paise; a test
  asserts every cost constant is an integer. `0.1 + 0.2 !== 0.3` is not a
  property you want in a recovery ledger.
- **A static singleton ledger.** Considered and rejected: state would leak
  between strategy runs, tests would become order-dependent, and two strategies
  could not be scored independently. The ledger is an instance.
- **Wall-clock timestamps in the audit trail.** Caught before it shipped. An
  audit ledger stamped with *when you ran the script* rather than when the event
  occurred is not an audit trail. Entries use simulation time, and a test
  asserts it.
- **Policies re-proposing blocked actions.** Fixed dunning loops on a refused
  channel because it never reads its own history. The agent inspects `blockedBy`
  and routes around it — a small change that removed a whole class of wasted
  steps.

---

## 7. The loss-type adapters broke everything, and that was the useful part

**What happened.** We had claimed the engine covered Razorpay's seven example
directions through `lossType`. It did not: `lossType` only scaled the transaction
amount. Checkout abandonment, subscription mandates and B2B receivables all ran
the identical playbook.

Adding real adapters dropped the agent from ₹9.16L to ₹3.54L and failed six tests
at once.

**Root cause.** The adapters correctly told the agent it cannot re-attempt a
charge nobody authorised — you cannot "retry" an abandoned checkout, and an
invoice is not an instrument. But the engine had no other way for money to come
back: a landed contact only ever unlocked a *retry*. So 28% of the cohort became
unrecoverable by construction, and only for the strategy honest enough to stop.

**Two fixes, both to the engine, both applied identically to every strategy:**

1. **A link-recovery path.** For loss types with nothing to charge, a landed
   nudge *is* the payment — the customer follows the link and pays.
2. **Retries on unauthorised loss types cannot succeed. For anyone.** This was
   the real bug. The simulator had been rewarding the baselines for charging
   people who never agreed to pay.

Naive retry fell from ₹7.30L to ₹2.13L, at 10.26 retries per recovery.

**The part worth noticing.** An earlier review pushed us to make naive retry
"structurally lose money" by inflating per-message cost constants until it did.
We refused, because rigging a benchmark is the fastest way to get caught. The
honest route to the same conclusion turned out to be **modelling authorisation
correctly** — and it produced a far more damning result than any cost table
would have, because it is true.

---

## 8. We were claiming a cost we never measured

**What happened.** After the loss-type fix, the agent lost `risk-spike`.

**Why.** That scenario is 32% hard declines. The agent refuses to retry them, so
it forgoes the ~1.5% that succeed anyway. Meanwhile the README and ADR 0003 both
asserted that retrying flagged instruments "harms the merchant's authorisation
rates" — and the simulator modelled no such harm. We were making an argument the
measurement did not support, and the model was quietly rewarding the behaviour we
called harmful.

**The fix.** `hardDeclineRetryPenaltyPaise` — ₹50 per retry against an issuer
decline, covering network fees for excessive retries on declined authorisations
plus auth-rate damage. Applied to every strategy equally.

On `risk-spike`, naive retry now spends ₹27,345 to recover ₹1.06L; the agent
spends ₹7,236. Restraint became measurable instead of rhetorical.

**A note on our own bias.** Both fixes moved results in our favour, and we are
aware of how that looks. Two things kept it honest: each change went into the
*engine* and applied identically to every strategy, and the agent itself was not
touched in either. The test asserting where the agent is allowed to lose was
updated only after the reason was written down — which is why
`KNOWN_AGENT_LOSSES` is still in the suite, and still empty.

---

## 9. A sensitivity analysis that was measuring its own noise

**What happened.** The annoyance-price sweep was built to answer the most
obvious attack on our headline metric: we price customer annoyance at ₹20 a
point, and that figure is a judgement call. Sweeping it from ₹0 to ₹100
showed the winner flipping to fixed dunning at ₹50 in `risk-spike` and at ₹100
in `stale-instruments`. We were ready to write that up as an honest limit.

**Then the numbers looked wrong.** The adaptive arm of the sweep produced
4.32L, 3.69L, 4.57L, 3.98L, 4.80L, 3.43L as the price rose. Net value should
fall monotonically as annoyance gets more expensive. It was swinging by about
1L in both directions.

**Root cause.** Changing the agent's spend threshold changes which actions it
takes, which changes how much randomness it consumes, which makes every price
point a different random draw. The robustness run had already measured the
agent's standard deviation across cohorts at roughly 0.9L -- the same size as
the swings. The sweep was reading its own noise floor and calling it
sensitivity.

**The fix.** Average every point over 15 seeds. The curves became monotonic,
and the Rs 50 flip in  disappeared entirely: it had been a
single-seed artefact.

**What it changed about the conclusion.** With noise removed and the agent
allowed to know the price it is being judged on, it posts the highest net value
at every price from ₹0 to ₹100, in all five scenarios. The ₹20 constant
is an input, not a thumb on the scale.

**The lesson worth keeping.** A sensitivity analysis dominated by noise is worse
than none, because it manufactures findings that feel like rigour. Two things
caught it: the result was non-monotonic when theory said it could not be, and
we already had an independent estimate of the noise floor from Part A to compare
against. Build the variance measurement first; it tells you which of your other
results you are allowed to read.

---

## 10. What the real API says, versus what the docs say

We built the failure taxonomy from Razorpay's published error documentation.
Then we drove an actual decline through their hosted checkout with one of their
failure test cards and read the payment back through the API. Three things came
out of it that reading documentation could not have told us.

**1. A payment link's `payments` array does not contain failed attempts.**

The first capture attempt reported "no payment attempts recorded yet" against a
link that had just been declined. The link object lists successful attempts
only. Since failures are the entire subject of this project, the decline had to
be read from the account's payments collection and matched on amount instead.
An obvious-in-hindsight API shape that no amount of doc-reading surfaced.

**2. The documented test card did not produce its documented error.**

Razorpay's test-card page lists `4100 2800 0002 0007` as producing
`gateway_technical_error`. What actually came back was:

```
error_code         BAD_REQUEST_ERROR
error_description  Payment failed
error_source       gateway
error_step         payment_authorization
error_reason       payment_failed
```

`payment_failed`, not `gateway_technical_error`. Our taxonomy recognised it
anyway — `payment_failed` is in the table and maps to `HARD_DECLINE` — so the
agent classified the real failure correctly and stopped, which is the right call
for a bank decline with no stated cause.

But the card-to-error mapping in the docs is not something to rely on. We had
already noticed the docs contradicting themselves elsewhere (`insufficient_fund`
on the test-card page, `insufficient_funds` on the error-code page). This is the
same class of problem, and it is the argument for having called the API at all
rather than trusting the documentation as a specification.

**3. A source mismatch we are recording rather than "fixing".**

Our taxonomy lists `payment_failed` with `source: 'bank'`. The API returned
`source: 'gateway'`. One observation is not enough to re-key the table — the
source plausibly varies with what actually failed — so this is noted here rather
than silently patched to match a single sample. Worth revisiting with more real
declines.

**Why this entry exists.** The live path was built to demonstrate that the agent
runs on real rails. It did that, but the more useful outcome was finding three
places where our model of Razorpay came from documentation rather than from
Razorpay. That is the difference between an integration and a claim.

---

## 11. The LLM policy lost, and the first result that said otherwise was an artefact

**What happened.** The LLM arm had never actually run. Two reasons stacked: the
client reads `process.env`, which never saw our `.env`; and once that was
bridged, the configured model id no longer existed on Groq, so all 203 requests
404'd. The policy fell back to the rules agent for every case and printed
numbers identical to it — which is the fallback working exactly as designed, and
also why nobody noticed it had never worked.

**The first real number was misleading.** With the model id fixed, the LLM agent
posted ₹4.34L against the rules agent's ₹3.97L, and for a few minutes we thought
the LLM was winning. It was not. 108 of 203 requests were being rejected on
rate limits, so the cache held only 90 decisions and the policy was falling back
to rules for **more than half its cases**. We were mostly measuring the rules
agent and crediting the LLM for it.

**With the model actually deciding:**

| | Rules agent | LLM agent |
|---|---|---|
| Net after annoyance | **₹3.97L** | ₹3.40L |
| Recovery rate | **49.2%** | 47.4% |
| Retries per recovery | **2.56** | 2.91 |
| Annoyance points | **806** | 1,225 |

The LLM is worse on every axis, and worst on restraint: 52% more customer
annoyance for less recovered revenue. It reaches for a message where the rules
agent has already worked out the expected value does not justify one.

**Why this is the better outcome.** Razorpay asks for "the right tool in the
right place, and where you chose *not* to use one". ADR 0003 argued the
classification and bounding work belongs in deterministic code. This is that
argument with a measurement attached rather than an assertion — and it is a
measurement that went against the fashionable answer.

The LLM arm stays in the repo. It is genuinely useful for messy or unseen reason
codes the taxonomy has no entry for, and it demonstrates that the guardrails hold
identically whichever policy proposes the action: **zero compliance violations on
the LLM run too.** What it is not is a reason to put a language model on the
critical path of a decision a lookup table makes better and for free.

**Two smaller things this shook out.**

Pacing the pre-warm dropped transport failures from 108 of 203 to 7. And 11
responses were rejected by schema validation — that is the validation layer doing
its job, not a fault: those are exactly the malformed outputs that would
otherwise have reached the guardrail stack.

The cache also defeated its own purpose at first. `prewarm` skipped duplicate
situations *within* a run but not ones already restored from disk, so a warm run
re-fetched all 203 decisions at the rate-limit gap and took as long as a cold
one. Seven minutes became seventy seconds once it checked.

---

## 12. `STOP` was doing the job of `WAIT`, and fixed dunning was winning because of it

**What happened.** Inspecting a single flagged case (`loss_00151`, a receivable
with a promise-to-pay) showed fixed dunning recovering money the reason-aware
agent did not. That should not happen on a receivable — the whole point of the
class is patience, which is exactly what a schedule offers for free and a
"smarter" agent has to earn.

**Root cause.** The promise-to-pay branch in `rules-agent.ts` returned `STOP`
once a promise was recorded but not yet due. `engine.ts` treats `stop` as
terminal — it ends the case forever, the same code path used for "this can
never be recovered, walk away." A promise that has not yet lapsed is the
opposite of that: it is a reason to do nothing *for now*, not a reason to close
the file. The agent was closing every well-behaved receivable the moment it
made a promise, before the promise window even had a chance to pay off.

**The fix.** A case can be finished in two genuinely different ways, and the
type system did not have words for both of them. Added a new `Action` kind,
`'wait'` — advance the clock, log it, and come back and ask `decide()` again —
distinct from `'stop'`, which now means only "this is actually over." Updated
the promise-to-pay branch to return `wait` with a delay computed from the
promise window, and taught `engine.ts` and the guardrails to treat `wait` as
free, unconditionally allowed, and non-terminal.

`loss_00151` now recovers ₹12,452 after six steps; it used to close at zero
after the first message landed.

**The harder question that came after.** Once `wait` existed, the deeper
critique of the reason-aware agent was that it is still fundamentally a lookup
table — better-informed than fixed dunning, but the same shape of answer:
"what class is this, what does the fixed playbook say." It cannot condition on
amount, on how many times a case has already failed, or on what already
bounced off which channel, because its schedule has no notion of any of those.

**What we built instead of accepting that.** `agent-adaptive`
(`src/policies/adaptive-agent.ts`) — not a replacement for the reason-aware
agent but a second, independent strategy, scored on the same cohorts. It builds
a short list of candidate actions per case (retry now, retry at several later
offsets, message on each available channel, escalate, stop), prices every one
of them in rupees against its own continuous-time belief curves
(`adaptive-model.ts`), and takes the highest expected value. A ₹500 case and an
₹80,000 case with the identical failure reason can legitimately receive
different treatment now — not a special case in the code, just expected value
scaling with the amount while a fixed schedule cannot.

**What it is not.** It does not learn from what it observes — its beliefs are
fixed at build time, same as the schedule agent's, deliberately approximate,
sometimes deliberately wrong. Cross-case online learning (a Bayesian estimator
updating its own odds as the cohort runs) was scoped out on purpose, not for
lack of trying: making `Strategy.decide()` stateful this close to the deadline
would touch the robustness harness, the sensitivity sweep and the live path all
at once, each of which currently assumes a pure function of one case in
isolation. `docs/adr/0008-why-not-online-learning-yet.md` has the full
reasoning and exactly what a follow-up would need.

**Measured, not asserted.** Across 250 independent cohorts (5 scenarios × 50
seeds), `agent-adaptive` posts the highest net value in 189 (75.6%), the
reason-aware agent in 60 (24.0%) — together, one of our own two strategies
beats every baseline in 249 of 250 (99.6%), with zero compliance violations
across every strategy and every run. The one loss belongs to a baseline in a
single cohort, and it stays in the numbers rather than getting explained away.

The annoyance-price sweep (`npm run eval:sensitivity`) tells an honest, mixed
story rather than a clean one: told what annoyance costs, `agent-adaptive`
wins at nearly every price point across all five scenarios, but at the high
end of the range (₹75–100 a point) it loses to the reason-aware agent in two
of five — a real limit, not smoothed over, because a strategy tuned until it
wins everywhere would be a strategy overfitted to the sweep.

---

## 13. `escalate_human`'s flat 55% was the same defect as entry 2, smaller

A follow-up audit (asked for explicitly: "is this genuinely adaptive, or a
fancier rules engine") found the escalate-human candidate used a bare
`const p = 0.55` regardless of recovery class, time, or attempt count — the
one candidate type in the whole EV framework that bypassed the belief-curve
system entirely. Consequence, measured directly: 78 of 82 human escalations
in one cohort (95%) were on classes where `engine.ts`'s `escalate_human`
branch has no mechanical path to recovery at all — it only sets
`customerActed`, which only matters for `CUSTOMER_ACTION_REQUIRED`. The rest
were pure cost: ~66% of the strategy's spend and ~58% of its spam, on an
action whose own stated rationale ("a person clears believed P=0.55") did
not match how the case actually got recovered, when it did.

**The fix.** Two regimes, not one number: where a human genuinely does
something a channel cannot (persuading a customer to fix a dead instrument
on a retryable loss type), price it like the strongest channel, capped at
the SAME landing odds already trusted for voice — no invented bonus.
Everywhere else, a small flat hedge (0.05), honestly labelled as a guess
with no modelled mechanism behind it, not a channel. Net effect on the same
cohort: recovered revenue and net value both went UP slightly (spend and
wasted human escalations went down, freeing the argmax to land on genuinely
effective actions more often) — not tuned for, the fixes were made once and
re-run once. Full before/after numbers in `README.md`.

**The belief curves were also too close to ground truth to call
independent.** Every parameter in `adaptive-model.ts` was within 5–20% of
`sim/recovery-model.ts`'s real values, one (HARD_DECLINE) identical to three
decimal places. Not a code-level leak — no import exists, and a test checks
that — but close enough that "deliberately approximate, in places
deliberately wrong" overstated their independence. Fixed by naming it: the
file now says plainly these are hand-authored prior beliefs, not
independently inferred ones, and explains why re-deriving them from nothing
would just be a different set of guesses with a false claim of
independence, not a truer one.

---

## 14. Unknown-case handling, a formal action registry, and voice

The most substantial addition to the agent since the EV rewrite (entry 12).
Three threads, one change:

**Unknown cases used to be one line: `STOP('unrecognised failure reason')`.**
No gradation between "fully documented" and "no idea." `CaseAssessment`
(`policies/assessment.ts`) replaces it with three states and three
confidence bands, and — the part worth stating precisely — uncertainty now
changes WHICH candidates are generated, never how a fixed set is scored.
No confidence multiplier exists anywhere in the pricing math. This was a
deliberate rejection: a multiplier tuned to look right on a benchmark is
indistinguishable from a multiplier tuned to game one, and the design
review that scoped this work called that out by name before any code was
written.

**A real bug, caught by the safety suite built alongside it, not by luck.**
The first cut of the confidence tiers let `retrySpec` fire for `inferred`
cases (a fuzzy-matched guess at an undocumented code) exactly as freely as
for `known` ones. `eval:novelty`'s `unknown_code_high_value` fixture — an
invented reason code that happens to share vocabulary with
`gateway_technical_error` — caught it immediately: the agent proposed a real
retry against a guessed class. Fixed by requiring `status === 'known'`
(documented code) for retry specifically, not merely `confidence !== 'low'`
— a guessed class is good enough to justify a cheap contact, never a real
retry attempt, because a wrong guess there risks the exact issuer-penalty
harm this project has argued against since entry 8.

**Voice was already 90% built and never used.** `Channel` has included
`'voice'` since early on; its cost, spam price, DND coverage and believed
landing odds all already existed. The only gap was that `agent-adaptive`'s
contact ladder never included it. Adding it is one line; everything that
prices and gates it — including quiet hours, DND, and consent — was already
generic across channels and needed no changes at all.

**The harder piece: making a contact resolve to more than true/false.**
Every channel until now drew a single boolean. Voice draws one of six
structured signals (`promise_to_pay`, `funds_available_now`,
`instrument_fixed`, `disputes_charge`, `refused`, `no_answer`) from a new,
independently-authored ground-truth distribution
(`sim/voice-signal-model.ts`), written to the case's own history and read
back on the next decision. "The agent replans off it" needed no new control
flow: `decide()` already runs every step, so a richer observation on this
step is just a richer input next time. `promise_to_pay` and
`funds_available_now` were routed into the SAME `wait`/`customerActed`
mechanisms already built for receivables and for a landed nudge, rather
than inventing parallel machinery.

**What this did not touch, on purpose.** `sim/recovery-model.ts`, the
financial benchmark's methodology (`eval:robust`, `eval:sensitivity`), and
the stateless `Strategy.decide()` contract are all unchanged — a new
boundary test (`policies/boundary.test.ts`) checks the ground-truth import
rule against every new file, not just the original two. Novelty/safety
results (`eval:novelty`, 12 hand-authored adversarial cases) are written to
their own file and their own dashboard section, deliberately never blended
with the ₹ figures above: a genuinely unknown case has no ground-truth
recovery curve to score, so inventing a revenue number for it would be
exactly the kind of thing this log exists to catch. Full design reasoning
in `docs/adr/0009-unknown-case-handling-and-voice.md`.

## 15. A nudge was priced as if it resolved in zero time

Found by comparing `agent-adaptive` against `agent-rules` on identical
randomness, case by case, not by a benchmark regression — the aggregate
numbers never dipped enough to flag this on their own. In 11 real cases
across every scenario, `agent-rules` recovered money that `agent-adaptive`
did not, and every one of the 11 shared the exact same `stoppedReason`:
`no candidate clears its cost`.

The cause was a boundary artefact, not a design choice.
`CUSTOMER_ACTION_REQUIRED`'s belief curve (`adaptive-model.ts`) is a `rise`
shape, `pMax * (1 - exp(-t/tau))`. At literal `elapsed = 0` — a case's very
first decision, the instant the payment just failed — that expression is
exactly zero by construction. `contactSpec` and `escalateSpec` were both
pricing their follow-up retry's odds at that same `elapsed`, which silently
assumes a nudge-then-retry sequence takes zero real time. It does not: the
customer has to receive the nudge, then actually go fix the instrument,
before a retry means anything. At `t = 0` every contact candidate priced as
pure cost with zero gain, lost to `stop`, and the case was abandoned
forever — even though the SAME nudge, priced moments later, was easily
worth it (the curve reaches 69% of its ceiling by 15 minutes, per its own
8-minute time constant).

Fixed by pricing the follow-up retry at `elapsed + an assumed nudge-response
delay` (20 minutes for a contact, the escalation's own existing 60-minute
delay for a human) instead of `elapsed` alone — a genuinely more accurate
model, not a special case bolted on to patch the symptom. Added a regression
test asserting a fresh `CUSTOMER_ACTION_REQUIRED` case at `elapsed = 0`
prices a real, positive-EV candidate rather than defaulting to `stop`.

Measured effect: 7 of the 11 cases are now recovered identically to
`agent-rules` (the remaining 4 are a different, unrelated situation — other
recovery classes where stopping is legitimately correct, untouched by this
fix). Rerunning the full suite after the fix: `eval:robust`'s combined win
rate held at 249/250 (99.6%, unchanged); `eval:sensitivity`'s sweep actually
improved, from a prior 39-of-40 scenario×price cells to a clean 40 of 40 —
the agent now posts the highest net value at every price from ₹0 to ₹100 in
all 5 scenarios, with no exceptions to report. `eval:novelty` unaffected
(12/12 safe, 0 violations, as before). None of the three checks were rerun
selectively to find a favourable result — all three were rerun in full and
reported as they came out, including the parts that did not move.

## 16. Channels were priced as if trying one used up the others

Found by hand-deriving the expected value of a concrete alternative before
writing any code, then checking the derivation against what the agent
actually did -- not by staring at the aggregate number and guessing.

For a ₹5,000 `CUSTOMER_ACTION_REQUIRED` case with every channel available,
the single-step pricing (as it existed through entry 15) picked voice
outright: its own expected value (₹1,831) beat every other channel's own
expected value, so voice won the argmax and every other channel was priced
as pure alternative, never as a fallback. But the engine already loops --
if voice fails to land, the very next decision offers whichever channels
remain unused. A one-step price that ignores this is wrong on its own
terms: it is comparing "voice, and nothing else" against "email, and
nothing else," when the real choice is "voice now" against "email now,
with voice still in reserve if email doesn't land."

Hand-computed the second option's true value before touching the code:
trying email first costs its own ₹2,020 always, plus voice's ₹21,500 only
in the ~80% of cases where email didn't already work -- total expected cost
₹19,220, not ₹21,500 flat. Expected value of that sequence: ₹2,263, about
24% more than jumping straight to voice. The gap is not a modelling
preference; it falls directly out of the arithmetic once "the other channel
is still available afterward" is priced instead of assumed away.

Implemented as a bounded, one-level lookahead in `contactSpec`
(`action-registry.ts`): each channel's candidate is now priced as
`ownGross - ownCost + P(this channel fails) x (best OTHER eligible
channel's own EV)`, folding in that continuation only in the failure
branch, and only the single best alternative -- not a general planner, not
unbounded recursion, one extra term that is provably correct for a 2-move
horizon and cheap to compute for every decision. The rationale string
names the channel held in reserve and the probability it gets used, so this
reasoning is visible in the dashboard's candidate table, not just in this
log.

Verified the prediction against the code before trusting either: the
`email` candidate's printed gross/cost matched the hand-derived numbers to
the rupee. The chosen channel for that case flipped from voice to
whatsapp (cheaper than voice, better landing odds than email, exactly the
channel a 2-move-lookahead should prefer) -- not hand-picked, the argmax
found it once the pricing was corrected.

Measured effect on baseline week: net value after annoyance rose from
₹4,41,507 to ₹5,35,786 (+21%), lift over fixed dunning rose from 56% to
90%, cost fell (₹3,871 to ₹3,536) and annoyance fell (925 to 814 spam
points) at the same time -- the mechanism is cost efficiency (expensive
channels are now paid for only when actually needed), not increased
aggression. Reran the full suite rather than trusting one scenario:
`eval:robust`'s adaptive-alone win share rose from 74.4% to 81.2% (combined
249/250 unchanged); `eval:sensitivity` still wins at every price point, all
5 scenarios; `eval:novelty` unaffected (12/12 safe, 0 violations). Reran,
not cherry-picked -- every one of the three checks was executed in full and
every number reported, including the ones (novelty; the combined
robustness figure) that did not move.

## 17. A "wait, don't give up forever" rule that looked right and measured wrong

Recorded because it is the useful kind of failure: a change that had a real
theoretical justification, passed every existing test, and still made the
actual result worse when measured on the full cohort. Worth writing down
so nobody re-tries the same idea a year from now without knowing it was
already checked.

The hypothesis: entries 15 and 16 both fixed the same shape of bug --
something priced as final ("this candidate is worthless" / "no channel is
worth trying") when the truth was "not worth it *right now*." The natural
next question: does `stop` itself have the same problem? An empirical
check said yes -- of 197 cases where `agent-adaptive` stopped with "no
candidate clears its cost," repricing the SAME case 2 days later showed a
genuinely positive-EV candidate in 71 of them (representing ~₹7.07L of
case value). That is a real, measurable gap, not a guess.

Implemented a bounded fix in `explain()`: when the winning candidate is
`stop` at EV<=0, reprice the identical case (same history, nothing has
actually happened) at a fixed +24h horizon; if that repricing finds a
real, positive-EV candidate, return `wait` instead of `stop`. One lookahead
call, a fixed cadence, no search over horizons -- deliberately the same
bounded shape as entries 15-16, one level up (the whole decision, not one
candidate's timing within it).

It passed all 219 existing tests. Rebuilt the full bundle anyway rather
than trusting that. **Net value after annoyance on baseline week fell from
₹5,35,786 to ₹5,07,932** (lift over fixed dunning: 89.7% to 79.8%) --
worse, not better. The isolated lookahead's repricing does not fully
capture what happens when a case is genuinely still open: contact
fatigue, attempt counts and the case-age horizon interact with the real
elapsed history in ways a one-shot "teleport forward and reprice" probe
doesn't reproduce, so some fraction of cases that would have stopped
cleanly instead spent real steps and case-lifetime waiting for value that
didn't materialise the same way when actually reached.

**Reverted.** The 71-of-197 diagnostic was real, but it measured "does a
positive candidate exist somewhere later," not "does actually building a
mechanism to reach it help" -- those are different questions, and only the
second one is the one that matters. Recorded as a genuine negative result,
not smoothed over: the theory was reasonable, the empirical answer was no,
and the honest move is to report both rather than keep a plausible-looking
change that the data doesn't support.

## 18. Annoyance was flat per channel, no matter how many times a customer had already been contacted

A skeptical-judge audit pass asked, among other things: does the agent's
own economics account for cumulative annoyance across repeated contact, or
does a customer's third message cost the same as their first? Checked
directly: `contactFatigue` (in `contactSpec`) already reduced a repeat
contact's believed *landing probability* -- that part was already honest.
But `SPAM_POINTS[channel]` itself, the number that becomes real rupees via
`annoyancePricePaise`, was a flat per-channel constant regardless of
`contactsSoFar`. A third WhatsApp message was priced as exactly as
annoying as the first, which under-counts the real cost of a long contact
history.

Fixed by scaling spam points by `ANNOYANCE_ESCALATION_PER_CONTACT ** contactsSoFar`
(1.4, a stated assumption in the same spirit as `BELIEVED_ATTEMPT_FATIGUE`,
just escalating instead of decaying) in the same `priceChannelAlone`
helper entry 16 already built. Measured, not assumed safe: net value after
annoyance on baseline week rose again, ₹5,35,786 to ₹5,40,467, lift over
fixed dunning 89.7% to 91.3% -- and recovered rupees, cost, AND total spam
points all moved in the agent's favour simultaneously (spam 814 to 749).
That combination -- more money, less spent, less annoyance, all at once --
is the strongest possible shape of result: it means the fix corrected a
real inaccuracy in the annoyance model rather than trading one objective
against another.

Reran the full suite: `eval:robust` (250 cohorts) -- combined win rate
249/250 to **250/250**, adaptive-alone win share 81.2% to 81.6%. Worth
being precise about that 250/250: it is not a manufactured sweep -- no
single scenario has any one strategy winning all 50 of its own seeds (see
the per-scenario breakdown in the dashboard's robustness section), so real
variance remains; it means that across every one of these 250
independently reseeded cohorts, at least one of our two strategies beat
every baseline, which is what the number has always measured.
`eval:sensitivity` still wins at every price point, all 5 scenarios.
`eval:novelty` unaffected, 12/12 safe, 0 violations. Added two regression
tests: one proving the escalation is real (same channel, same case, same
elapsed time, higher spam price the more the customer has already been
contacted), one proving -- against the real engine and ledger, not just
the pricing layer -- that no ledger entry of any kind exists after the
entry that actually recovered a case, across 40 varied real cases with a
nonzero number of genuine recoveries among them.
