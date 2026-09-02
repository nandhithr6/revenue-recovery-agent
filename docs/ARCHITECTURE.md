# Architecture

Razorpay's brief asks for architecture documentation. This is it: what the pieces
are, why they are separated where they are, and what each one is not allowed to
do.

The single organising idea: **the policy proposes, the guardrails dispose, and
nothing executes without a verdict.** Every other decision follows from wanting
that separation to be structural rather than a convention people remember.

---

## 1. The pipeline

```
  LossEvent
     │
     ▼
  Triage ──────────► lookupReason(code) → RecoveryClass
     │                (public Razorpay taxonomy; no privileged data)
     ▼
  Policy ──────────► Action { kind, channel?, delayMs, rationale }
     │                agent-rules │ agent-llm │ naive-retry │ fixed-dunning
     ▼
  Guardrails ──────► Verdict { allow │ defer(notBefore) │ block(rule) }
     │                compliance + stopping rules
     ▼
  Executor ────────► SimulatedExecutor  │  RazorpayExecutor
     │                (seeded, measured)   (live test-mode API)
     ▼
  Ledger ──────────► append-only, simulation-clock, every decision + refusal
     │
     ▼
  Evaluator ───────► net value after annoyance, vs baselines
```

---

## 2. The layers, and what each may not do

| Layer | Path | May not |
|---|---|---|
| **Domain** | `src/domain/` | — |
| **Simulator** | `src/sim/` | be imported by any policy |
| **Policies** | `src/policies/` | read ground truth; execute anything |
| **Guardrails** | `src/guardrails/` | know which policy proposed the action |
| **Executor** | `src/eval/engine.ts`, `src/live/` | run an action without an `allow` |
| **Ledger** | `src/ledger/` | use wall-clock time |
| **Evaluator** | `src/eval/` | be reachable from a policy |

### Domain — `src/domain/`

`failure-taxonomy.ts` holds 21 real Razorpay `reason` codes for cards and UPI,
each mapped to one of six recovery classes. The codes are Razorpay's; the class
mapping is ours, and is documented as an assumption in `SOURCES.md`.

`types.ts` holds the money type. **All currency is integer paise.** No float ever
touches a rupee value — rounding drift in a recovery ledger is indefensible, and
Razorpay's own API takes paise, so there is no conversion at the boundary either.

### Simulator — `src/sim/`

Generates cohorts and holds **ground truth**: the real probability a retry
succeeds, as a function of recovery class and elapsed time. Each class has a
differently *shaped* curve — infrastructure recovers as an outage clears, funds
recover over days, abandonment decays hourly — which is what makes *when* you act
matter, and therefore what a reason-aware policy can exploit.

Seeded throughout (`rng.ts`). Same scenario, same cohort, every time.

### Policies — `src/policies/`

A policy is one function: `decide(ctx: CaseContext) => Action`.

`CaseContext` is deliberately narrow — the failure reason, amount, method, loss
type, elapsed time, what has been tried, which channels are consented to, and
which guardrail rules have already fired. **Nothing else.** In particular, never
the simulator's recovery odds. See ADR 0005; `playbook.ts` carries a standing
note that it must never import from `sim/recovery-model.ts`.

The agent carries its *own* believed odds, deliberately approximate and in places
deliberately wrong. It has to win with imperfect beliefs, because that is the
only kind anyone has in production.

Two orthogonal inputs shape a decision:

- **Recovery class** — what is wrong, and therefore what would fix it
- **Loss type** — what recovery is even *permitted*

The second exists because you cannot re-attempt a charge nobody authorised. An
abandoned checkout has no mandate behind it; an invoice is not an instrument. A
loss type may extend a retry schedule but never conjure one for a class whose
playbook says retrying can never work.

### Guardrails — `src/guardrails/`

The gate every action passes through. Two rule families, and the distinction
between them is the important part:

- **Timing rules defer.** Quiet hours, cooldowns, daily caps. Not permitted
  *now*; permitted later. A message that would land at 21:30 is queued for 09:00,
  not dropped. (ADR 0006)
- **Permission rules block.** DND, missing consent, exhausted budgets. No amount
  of waiting helps, so deferring would queue a contact that may never legally be
  made.

Stopping rules live here too: attempt caps, case age, and a global kill switch.
Terminal rules close a case rather than being re-proposed.

The gate does not know which policy proposed the action. That is what makes
"even a hallucinating LLM cannot exceed the cap" a structural property rather
than a hope — and it is measured: zero compliance violations across every
strategy and every run, including the LLM arm and an adversarial policy written
to breach everything.

### Executor — `src/eval/engine.ts` and `src/live/`

The only code that can make an action happen, and it will not without an `allow`.

Two implementations behind one policy surface (ADR 0007):

- **Simulated** — seeded, reproducible, used for every measurement
- **Razorpay** — live test mode; retries create real orders, customer contact
  creates real payment links with openable URLs

The same agent and the same gate drive both. There is no `if (live)` anywhere
above this layer.

### Ledger — `src/ledger/`

Append-only, frozen entries, sequential ids, **stamped with simulation time**. An
audit trail recording when you happened to run the script is not an audit trail.

Blocked actions are recorded, not swallowed. "We did not contact them, and here
is the rule that stopped us" is itself the compliance evidence.

An instance, never a static singleton — two strategies must run over one cohort
without their histories bleeding together.

### Evaluator — `src/eval/`

Scores on **net value after annoyance**: recovered − spend − (annoyance × ₹20).
One number rather than two columns, because two columns let a reader pick
whichever favours their conclusion (ADR 0004).

Also: robustness across 50 seeded cohorts per scenario, and a sensitivity sweep
over the annoyance price so that constant is shown not to be doing the work.

---

## 3. Why the separations are where they are

**Policy | Guardrails.** A payments company is not evaluating whether a model is
clever. It is evaluating whether the thing can be trusted near money. Putting the
limits inside the policy would mean trusting the policy; putting them outside
means not having to.

**Agent | Ground truth.** An agent reading the simulator's odds would be grading
its own exam. The wall is enforced by a documented import ban and by the fact
that `CaseContext` simply has no field for it.

**Simulator | Live.** Measurement needs hundreds of seeded cohorts nobody can pay
for by hand. Credibility needs real API calls. Neither substitutes for the other,
and the live path deliberately produces no recovery percentage.

**Policy | Executor.** Swapping the executor without touching the agent is what
turns the layering claim into evidence.

---

## 4. Data flow, end to end

1. `generateCohort(scenario, start)` → 500 seeded `LossEvent`s
2. For each, until stop or the engine backstop:
   - `strategy.decide(ctx)` → `Action` with a written rationale
   - `gate(action, …)` → allow / defer / block
   - on defer, the clock advances to `notBefore` and the gate re-runs
   - on allow, the executor runs it and ground truth decides the outcome
   - every branch writes a ledger entry
3. `score(run)` → metrics; `breakdownByClass` / `breakdownByMethod` → detail
4. `run-all.ts` → one JSON bundle the dashboard reads

The dashboard never simulates anything. There is one source of truth, and the
pitch video contains no number that did not come out of it.

---

## 5. Commands

| Command | Does |
|---|---|
| `npm run eval [scenario]` | One cohort, all strategies, printed comparison |
| `npm run eval:all` | Every scenario → the dashboard bundle |
| `npm run eval:robust` | 50 seeded cohorts per scenario |
| `npm run eval:sensitivity` | Sweep the annoyance price |
| `npm run live` | The same agent against Razorpay's test API |
| `npm run decline:create` / `:capture` | Capture a genuine decline |
| `npm run dashboard` | The viewer |
| `npm test` | 118 tests |

---

## 6. Decisions

Recorded as ADRs in [`docs/adr/`](adr/), including the two that were later
reversed or measured against — kept as written rather than edited, because the
reasoning that changed is the interesting part.

What broke along the way is in [`ENGINEERING-LOG.md`](ENGINEERING-LOG.md).
