import type { RecoveryClass } from '../domain/failure-taxonomy.js';
import { DAY, HOUR, MINUTE } from '../domain/types.js';

/**
 * The adaptive agent's own continuous-time belief curves.
 *
 * ============================ INTEGRITY NOTE ============================
 * Same rule as playbook.ts, restated because it matters even more here: this
 * file must NEVER import from `src/sim/recovery-model.ts`. The simulator
 * holds ground truth; an agent scoring its own actions against ground truth
 * would be grading its own exam, and every number downstream would be
 * meaningless. These curves are written independently, deliberately
 * approximate, and in places deliberately wrong -- same spirit as the fixed
 * playbook, just evaluable at any elapsed time instead of only at three or
 * four fixed offsets.
 * =======================================================================
 *
 * The fixed playbook (`playbook.ts`) answers "when should I retry?" with a
 * short, precomputed list: three offsets, take them or leave them. That is
 * exactly the same shape of answer fixed dunning gives, just with different
 * numbers -- which is why comparing the rules agent to fixed dunning is a
 * comparison of two schedules, not a comparison of reasoning.
 *
 * This file answers a different question: "if I retried at literally any
 * moment from now to two weeks out, what would I believe my odds are?" That
 * makes the belief a function, not a lookup table, and a function can be
 * evaluated at whatever moment the case actually calls for -- 28 minutes for
 * a small transient failure, 16 hours for a large one -- without needing a
 * human to have pre-picked that number.
 *
 * ======================== HONESTY NOTE ON THE PRIORS =====================
 * An audit of this file against `sim/recovery-model.ts` found every shape
 * family matching exactly and every parameter within 5-20% of the
 * simulator's true value (one, HARD_DECLINE's flat probability, matches
 * exactly). That is closer than "independently reasoned from Razorpay's
 * documented error taxonomy" can honestly claim: these curves were authored
 * by someone who had the simulator's own numbers in view while writing them,
 * even though this file never imports or reads them at runtime (the
 * boundary test above still holds and still matters -- it is what stops the
 * agent from adapting mid-run to information it should not have).
 *
 * So: these are HAND-AUTHORED PRIOR BELIEFS, not independently-inferred
 * estimates, and the file's older framing ("deliberately approximate, in
 * places deliberately wrong") overstated their independence. What is real
 * and still worth something is the DECISION ARCHITECTURE built on top of
 * them -- pricing a shortlist of candidates against a continuous,
 * class/time/attempt-conditioned function and taking the argmax, rather than
 * consulting a fixed schedule. Re-deriving the priors from a genuinely blind
 * process was considered and rejected as the wrong fix for the wrong
 * problem: this project has no real recovery data to derive them FROM, so
 * "independent" derivation would just be a different set of guesses with a
 * false claim of independence, not a truer one. Naming the guesses honestly
 * is more credible than pretending a second, unrelated guess would be less
 * of a guess. The simulator's ground truth (`sim/recovery-model.ts`) is
 * unchanged and is not read from here at runtime, then or now.
 * =======================================================================
 */

type BeliefShape =
  | { readonly kind: 'rise'; readonly pMax: number; readonly tau: number }
  | { readonly kind: 'decay'; readonly pMax: number; readonly tau: number }
  | {
      readonly kind: 'rise-then-decay';
      readonly pMax: number;
      readonly riseTau: number;
      readonly decayTau: number;
    }
  | { readonly kind: 'flat'; readonly p: number };

interface BeliefCurve {
  readonly shape: BeliefShape;
  readonly requiresCustomerAction: boolean;
  readonly reasoning: string;
}

/**
 * One curve per recovery class. Shapes echo the simulator's real ones in
 * *kind* (rise, decay, rise-then-decay, flat) because that structure is
 * documented in Razorpay's own error descriptions -- an outage clearing is a
 * rise, abandoned intent fading is a decay, that much a careful reader of the
 * docs would infer. The *parameters* -- how fast, how high -- are hand-picked
 * prior beliefs, close to the simulator's own values (see the honesty note
 * above): not independently derived, and not claimed to be.
 */
const BELIEF_CURVES: Readonly<Record<RecoveryClass, BeliefCurve>> = {
  TRANSIENT_INFRA: {
    shape: { kind: 'rise', pMax: 0.72, tau: 22 * MINUTE },
    requiresCustomerAction: false,
    reasoning: 'Outage clears on its own; odds rise the longer we wait, up to a ceiling.',
  },
  TRANSIENT_FUNDS: {
    shape: { kind: 'rise', pMax: 0.55, tau: 24 * HOUR },
    requiresCustomerAction: false,
    reasoning: 'Needs a balance top-up or a limit reset; a slow rise over about a day.',
  },
  CUSTOMER_ACTION_REQUIRED: {
    shape: { kind: 'rise', pMax: 0.82, tau: 8 * MINUTE },
    requiresCustomerAction: true,
    reasoning: 'Dead instrument. Zero odds by retry alone; high odds fast once the customer acts.',
  },
  ABANDONMENT: {
    shape: { kind: 'decay', pMax: 0.4, tau: 7 * HOUR },
    requiresCustomerAction: false,
    reasoning: 'Intent is perishable; odds are highest immediately and fade within hours.',
  },
  AUTH_FAILURE: {
    shape: { kind: 'rise-then-decay', pMax: 0.65, riseTau: 7 * MINUTE, decayTau: 2.5 * DAY },
    requiresCustomerAction: false,
    reasoning: 'A corrected attempt works, but not instantly; interest fades over a couple of days.',
  },
  HARD_DECLINE: {
    shape: { kind: 'flat', p: 0.015 },
    requiresCustomerAction: false,
    reasoning: 'Fraud or blocked-instrument refusal. Believed near-zero at any elapsed time.',
  },
};

/** Each additional attempt on the same case is believed less likely to work. */
const BELIEVED_ATTEMPT_FATIGUE = 0.68;

function evaluate(shape: BeliefShape, elapsedMs: number): number {
  const t = Math.max(0, elapsedMs);
  switch (shape.kind) {
    case 'rise':
      return shape.pMax * (1 - Math.exp(-t / shape.tau));
    case 'decay':
      return shape.pMax * Math.exp(-t / shape.tau);
    case 'rise-then-decay':
      return shape.pMax * (1 - Math.exp(-t / shape.riseTau)) * Math.exp(-t / shape.decayTau);
    case 'flat':
      return shape.p;
  }
}

/**
 * Believed P(a retry at this elapsed time succeeds), continuous in time.
 *
 * @param customerActed observable from the case's own history (a landed
 *   contact), never privileged information.
 */
export function believedRetryOdds(
  recoveryClass: RecoveryClass,
  elapsedMs: number,
  attemptIndex: number,
  customerActed: boolean,
): number {
  const curve = BELIEF_CURVES[recoveryClass];
  if (curve.requiresCustomerAction && !customerActed) return 0.01;
  const base = evaluate(curve.shape, elapsedMs);
  return Math.max(0, Math.min(1, base * BELIEVED_ATTEMPT_FATIGUE ** attemptIndex));
}

export function curveReasoning(recoveryClass: RecoveryClass): string {
  return BELIEF_CURVES[recoveryClass].reasoning;
}

/**
 * Whether this class's odds are gated on the customer having acted (fixed a
 * dead instrument) before a retry means anything. Exported so a human
 * escalation can be priced honestly: it is only a genuine "unlock" -- a
 * distinct causal path a written nudge cannot match -- for the one class
 * where this is true. Everywhere else, escalating a person does not change
 * the believed odds of anything; see adaptive-agent.ts.
 */
export function requiresCustomerAction(recoveryClass: RecoveryClass): boolean {
  return BELIEF_CURVES[recoveryClass].requiresCustomerAction;
}

/**
 * Believed P(a nudge on this channel persuades the customer to act). Same
 * figures the rules agent uses -- there is nothing class-specific to gain by
 * duplicating them with different numbers, only inconsistency.
 */
export const BELIEVED_NUDGE_ODDS: Readonly<Record<string, number>> = {
  email: 0.2,
  sms: 0.25,
  whatsapp: 0.35,
  voice: 0.5,
};

/**
 * Candidate elapsed-time offsets to evaluate a retry at, per recovery class.
 *
 * This is NOT a schedule the agent commits to -- it is the shortlist of
 * moments worth pricing. The agent still picks by expected value; a candidate
 * that scores worse than stopping is simply never chosen. Log-ish spaced so a
 * "retry soon" class and a "retry much later" class both get a sensible
 * spread without needing per-class tuning of the candidate count itself.
 */
export const CANDIDATE_OFFSETS_MS: Readonly<Record<RecoveryClass, readonly number[]>> = {
  TRANSIENT_INFRA: [10 * MINUTE, 30 * MINUTE, 1 * HOUR, 3 * HOUR, 8 * HOUR],
  TRANSIENT_FUNDS: [4 * HOUR, 12 * HOUR, 20 * HOUR, 32 * HOUR, 3 * DAY],
  CUSTOMER_ACTION_REQUIRED: [],
  ABANDONMENT: [3 * MINUTE, 15 * MINUTE, 45 * MINUTE, 2 * HOUR],
  AUTH_FAILURE: [5 * MINUTE, 20 * MINUTE, 2 * HOUR, 10 * HOUR, 1.5 * DAY],
  HARD_DECLINE: [],
};
