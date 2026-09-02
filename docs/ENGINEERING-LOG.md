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
