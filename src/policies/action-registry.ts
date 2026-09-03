import type { RecoveryClass } from '../domain/failure-taxonomy.js';
import { DAY, HOUR, type Action, type ActionKind, type Channel, type Paise } from '../domain/types.js';
import { SPAM_POINTS } from '../guardrails/compliance.js';
import type { CostModel } from '../sim/scenario.js';
import {
  BELIEVED_NUDGE_ODDS,
  CANDIDATE_OFFSETS_MS,
  believedRetryOdds,
  curveReasoning,
  requiresCustomerAction,
} from './adaptive-model.js';
import type { CaseState } from './case-state.js';
import type { LossProfile } from './loss-profiles.js';
import { STOP, type CaseContext } from './types.js';

/**
 * The formal action registry (Part D of the design review).
 *
 * Each recovery action -- retry, one entry per channel, human escalation,
 * stop -- is one `ActionSpec`: its eligibility, its pricing, and the
 * metadata that used to live only in scattered comments now live in one
 * declared place.
 *
 * Every `Candidate` carries its GROSS expected recovery, direct cost and
 * annoyance separately, not just a net figure -- both so `buildCandidates`
 * can annotate strictly-dominated candidates for transparency (see the
 * bottom of this file) and so the dashboard can show the same breakdown a
 * reader would need to check the arithmetic by hand (Part 12 of the
 * economics-optimisation review).
 */

export interface Candidate {
  readonly action: Action;
  /** Believed recovered amount, before any cost or annoyance is subtracted. */
  readonly grossRecoveryPaise: number;
  readonly costPaise: number;
  readonly spamPoints: number;
  /** costPaise + spamPoints priced in rupees -- the two "what does this cost" axes as one number, for dominance comparison. */
  readonly totalCostPaise: number;
  /** grossRecoveryPaise - totalCostPaise. What the argmax actually compares. */
  readonly expectedValuePaise: number;
  /** Set by `buildCandidates` when another candidate costs no more, annoys no more, and recovers no less. Never changes selection -- argmax already cannot pick a dominated candidate -- this is purely for the "why not X" explanation. */
  dominated?: boolean;
}

export interface ActionMetadata {
  readonly kind: ActionKind;
  readonly channel?: Channel;
  readonly requiresConsent: boolean;
  /** True if choosing this and it not working leaves the case no worse off
   *  than before (no money spent touching the customer). Stop/wait: true.
   *  Retry: true (cheap, no customer contact). Contact/voice/escalate: false. */
  readonly reversible: boolean;
}

export interface PricingInput {
  readonly ctx: CaseContext;
  readonly state: CaseState;
  readonly recoveryClass: RecoveryClass;
  readonly profile: LossProfile;
  readonly costs: CostModel;
  readonly annoyancePricePaise: Paise;
}

export interface ActionSpec {
  readonly metadata: ActionMetadata;
  /** Price every candidate this action type can offer for this case; zero, one, or many. */
  price(input: PricingInput): readonly Candidate[];
}

/** Rs 20 of amount-at-risk "wasted" per hour of delay -- see adaptive-agent.ts's original note. */
const OPPORTUNITY_COST_PER_HOUR = 0.0006;

const HUMAN_UNLOCK_LANDING_ODDS: number = BELIEVED_NUDGE_ODDS.voice ?? 0.5;
const HUMAN_LAST_RESORT_ODDS = 0.05;

/**
 * A nudge does not resolve instantly: the customer has to receive it, then
 * actually go fix the instrument, before a retry means anything. Pricing the
 * follow-up retry at the SAME elapsed time the nudge itself is sent silently
 * assumes that round trip takes zero time -- which happens to be exactly
 * right almost everywhere (`believedRetryOdds`'s curves are already smooth
 * and slow-moving relative to it), except at the one moment it produces a
 * real bug: a case's very first decision, at literal elapsed=0. There,
 * CUSTOMER_ACTION_REQUIRED's `rise` curve (see adaptive-model.ts) evaluates
 * to exactly zero by construction (`1 - exp(-0/tau) = 0`), so every contact
 * candidate prices as pure cost with zero gain, loses to `stop`, and the
 * case is abandoned forever -- even though nudging is obviously worthwhile
 * moments later. Pricing the follow-up retry at `elapsed + this delay`
 * fixes the boundary case honestly (it is a genuinely more accurate model:
 * a nudge-then-retry sequence really does take some real time) rather than
 * special-casing elapsed=0.
 */
const ASSUMED_NUDGE_RESPONSE_DELAY_MS = 20 * 60_000;

/**
 * Each additional contact on the SAME case is believed to annoy the
 * customer more than the last, not the same amount -- a third message in
 * a week reads differently to the person receiving it than the first did.
 * 1.4, not tuned to a target number: a round, stated assumption in the
 * same spirit as `BELIEVED_ATTEMPT_FATIGUE` (0.68) it mirrors, just
 * escalating instead of decaying. Applied to spam points, which are
 * priced in rupees via `annoyancePricePaise` downstream, so this changes
 * real economics, not just a display number.
 */
const ANNOYANCE_ESCALATION_PER_CONTACT = 1.4;

function candidate(
  action: Action,
  grossRecoveryPaise: number,
  costPaise: number,
  spamPoints: number,
  annoyancePricePaise: Paise,
): Candidate {
  const annoyancePaise = spamPoints * annoyancePricePaise;
  const totalCostPaise = costPaise + annoyancePaise;
  return {
    action,
    grossRecoveryPaise,
    costPaise,
    spamPoints,
    totalCostPaise,
    expectedValuePaise: grossRecoveryPaise - totalCostPaise,
  };
}

// ---------------------------------------------------------------- retry ---

const retrySpec: ActionSpec = {
  metadata: { kind: 'retry_payment', requiresConsent: false, reversible: true },
  price({ ctx, state, recoveryClass, profile, costs, annoyancePricePaise }): readonly Candidate[] {
    if (!profile.canRetryCharge || state.blockedRules.has('MAX_RETRIES')) return [];
    // Retry requires the class to be DOCUMENTED, not merely guessed.
    // `inferred` (a fuzzy string match against an undocumented code, or an
    // LLM's guess -- either way, never above MEDIUM confidence) is enough to
    // justify a cheap, low-risk contact, but spending a real retry attempt
    // on a guessed class risks the exact thing this project has argued
    // against elsewhere: repeated authorisation attempts against what might
    // actually be a HARD_DECLINE in disguise damage the merchant's real
    // authorisation rate. `known` (documented code, whether or not this
    // case also carries an unrelated context anomaly) is the only status
    // that clears that bar.
    if (state.assessment.status !== 'known') return [];

    const elapsed = ctx.now - ctx.event.occurredAt;
    const opportunityCost = (delayMs: number): number =>
      ctx.event.amountPaise * OPPORTUNITY_COST_PER_HOUR * (delayMs / HOUR);

    if (state.customerActed) {
      const p = believedRetryOdds(recoveryClass, elapsed, state.attemptsSoFar, true);
      return [
        candidate(
          {
            kind: 'retry_payment',
            delayMs: 5 * 60_000,
            rationale: `customer acted on a nudge; retrying now against believed P=${p.toFixed(2)}`,
          },
          ctx.event.amountPaise * p,
          costs.retryCostPaise,
          0,
          annoyancePricePaise,
        ),
      ];
    }

    return CANDIDATE_OFFSETS_MS[recoveryClass].map((offset) => {
      const delayMs = Math.max(0, offset - elapsed);
      const atElapsed = Math.max(elapsed, offset);
      const p = believedRetryOdds(recoveryClass, atElapsed, state.attemptsSoFar, false);
      let cost = costs.retryCostPaise + opportunityCost(delayMs);
      if (recoveryClass === 'HARD_DECLINE') cost += costs.hardDeclineRetryPenaltyPaise;
      return candidate(
        {
          kind: 'retry_payment' as const,
          delayMs,
          rationale: `${recoveryClass}: retry at +${(offset / HOUR).toFixed(1)}h, believed P=${p.toFixed(2)} -- ${curveReasoning(recoveryClass)}`,
        },
        ctx.event.amountPaise * p,
        cost,
        0,
        annoyancePricePaise,
      );
    });
  },
};

// -------------------------------------------------------------- contact ---

/**
 * Whether a landed contact on THIS case has any modelled path to recovery
 * at all, per `engine.ts`'s actual mechanics (not this file's wishful
 * thinking about what a nudge "should" do):
 *
 *   - `!profile.canRetryCharge` -- checkout_abandonment and receivable are
 *     exactly the loss types `sim/recovery-model.ts:recoversViaLink` marks
 *     link-recoverable (the two sets are identical in this codebase's four
 *     loss types), and for those, the customer acting on the nudge IS the
 *     recovery path.
 *   - `requiresCustomerAction(recoveryClass)` -- CUSTOMER_ACTION_REQUIRED's
 *     curve is the one class whose odds are gated on `customerActed`, so a
 *     landed nudge genuinely unlocks a better subsequent retry.
 *
 * For every other combination (the majority of real cases: the four other
 * classes on payment_failure/subscription_mandate), the engine's own
 * `customerActed` flag is read nowhere that affects the outcome. A contact
 * there is not "somewhat less effective" -- it is exactly as effective as
 * never sending it, and pricing it with the full class curve anyway is the
 * defect this function exists to stop. (Same category of bug already found
 * and fixed for `escalate_human` -- see the engineering log.)
 */
function contactHasCausalPath(recoveryClass: RecoveryClass, profile: LossProfile): boolean {
  return !profile.canRetryCharge || requiresCustomerAction(recoveryClass);
}

/** Each additional contact attempt is believed somewhat less likely to land than the last -- reusing the SAME fatigue constant `believedRetryOdds` already applies to repeated retries, rather than inventing a second one. */
function contactFatigue(contactsSoFar: number): number {
  return 0.68 ** contactsSoFar; // BELIEVED_ATTEMPT_FATIGUE, same value, see adaptive-model.ts
}

interface ChannelBasePricing {
  readonly channel: Channel;
  readonly landingP: number;
  readonly grossRecoveryPaise: number;
  readonly costPaise: number;
  readonly spamPoints: number;
  readonly ownEvPaise: number;
}

/**
 * One channel's pricing taken alone, ignoring any other channel that might
 * still be available afterward -- what `contactSpec` priced before the
 * two-step lookahead below existed, and still the building block it's built
 * from.
 */
function priceChannelAlone(
  channel: Channel,
  { ctx, state, recoveryClass, costs, annoyancePricePaise }: PricingInput,
): ChannelBasePricing {
  const elapsed = ctx.now - ctx.event.occurredAt;
  const landingP = (BELIEVED_NUDGE_ODDS[channel] ?? 0) * contactFatigue(state.contactsSoFar);
  // See ASSUMED_NUDGE_RESPONSE_DELAY_MS: the retry this nudge unlocks
  // happens after the customer responds, not at the instant the nudge is
  // sent.
  const retryPAfterNudge = believedRetryOdds(
    recoveryClass,
    elapsed + ASSUMED_NUDGE_RESPONSE_DELAY_MS,
    state.attemptsSoFar,
    true,
  );
  const grossRecoveryPaise = ctx.event.amountPaise * landingP * retryPAfterNudge;
  const costPaise = costs.contactCostPaise[channel];
  // A customer's third message is not merely as annoying as their first --
  // `contactFatigue` above already prices repeated contact as less
  // EFFECTIVE (lower landing odds); this prices it as more COSTLY too,
  // reusing the same escalation shape in the other direction. Without
  // this, the pricing under-counted the true annoyance of a long contact
  // history: a channel's spam price was a flat per-channel constant no
  // matter how many times this same customer had already been reached.
  const spamPoints = (SPAM_POINTS[channel] ?? 0) * ANNOYANCE_ESCALATION_PER_CONTACT ** state.contactsSoFar;
  const annoyancePaise = spamPoints * annoyancePricePaise;
  return { channel, landingP, grossRecoveryPaise, costPaise, spamPoints, ownEvPaise: grossRecoveryPaise - costPaise - annoyancePaise };
}

/**
 * Which OTHER channels would still be genuinely available on the NEXT
 * decision if this one is tried and fails to land -- same eligibility gate
 * `contactSpec` itself applies, just evaluated for every channel at once so
 * one channel's price can see what its own failure leaves in reserve.
 */
function eligibleChannels(input: PricingInput): readonly Channel[] {
  const { ctx, state, recoveryClass, profile } = input;
  if (!contactHasCausalPath(recoveryClass, profile)) return [];
  return ladderFor(recoveryClass, profile).filter(
    (c) =>
      ctx.event.customer.consent[c] &&
      !state.channelsUsed.includes(c) &&
      !state.blockedChannels.has(c) &&
      !state.blockedRules.has('MAX_CONTACTS') &&
      !state.blockedRules.has('WEEKLY_CONTACT_CAP'),
  );
}

/**
 * One spec per channel. Each is priced with a bounded, one-level lookahead,
 * not in isolation: trying a channel and having it fail does not end the
 * case, it just means the NEXT decision offers whichever other channel is
 * still unused (`contactSpec` above already excludes used channels; the
 * engine's own decide-loop already re-runs after every failure). A
 * single-step price that ignores this systematically overvalues the single
 * best-looking channel and undervalues cheaper ones that could be tried
 * first at no loss -- if the cheap channel lands, the expensive one and its
 * cost are never needed at all; if it doesn't, the expensive one is still
 * exactly as available as it would have been anyway. Concretely: for a
 * ₹5,000 CUSTOMER_ACTION_REQUIRED case with email and voice both available,
 * one-step pricing picks voice outright (EV ~₹1,831); pricing "email now,
 * voice only if email fails" is worth ~₹2,263 -- about 24% more -- because
 * voice's cost is paid only in the ~80% of cases where email didn't already
 * work. This is exactly that: `ownEvPaise` of every OTHER eligible channel
 * is compared, and the single best one is folded in, weighted by the
 * probability THIS channel fails to land, as a continuation value. It is a
 * bounded 1-level lookahead, not a general planner: it reasons about "this
 * channel, then the best next one," not an arbitrary sequence, which keeps
 * it deterministic, cheap to compute, and easy to explain in one sentence
 * in the rationale string below.
 */
function contactSpec(channel: Channel): ActionSpec {
  return {
    metadata: { kind: 'contact_customer', channel, requiresConsent: true, reversible: false },
    price(input: PricingInput): readonly Candidate[] {
      const { ctx, state, recoveryClass, profile, annoyancePricePaise } = input;
      if (!ctx.event.customer.consent[channel]) return [];
      if (state.channelsUsed.includes(channel)) return [];
      if (state.blockedChannels.has(channel)) return [];
      if (state.blockedRules.has('MAX_CONTACTS') || state.blockedRules.has('WEEKLY_CONTACT_CAP')) return [];
      if (!contactHasCausalPath(recoveryClass, profile)) return [];

      const own = priceChannelAlone(channel, input);

      const others = eligibleChannels(input)
        .filter((c) => c !== channel)
        .map((c) => priceChannelAlone(c, input));
      const bestOther = others.reduce<ChannelBasePricing | undefined>(
        (best, c) => (best === undefined || c.ownEvPaise > best.ownEvPaise ? c : best),
        undefined,
      );

      // Continuation only counts if it's worth something and only in the
      // branch where THIS channel failed to land -- an already-landed nudge
      // needs no fallback.
      const continuationP = bestOther && bestOther.ownEvPaise > 0 ? 1 - own.landingP : 0;
      const grossRecoveryPaise = own.grossRecoveryPaise + continuationP * (bestOther?.grossRecoveryPaise ?? 0);
      const costPaise = own.costPaise + continuationP * (bestOther?.costPaise ?? 0);
      const spamPoints = own.spamPoints + continuationP * (bestOther?.spamPoints ?? 0);

      const rationale =
        bestOther && continuationP > 0
          ? `${recoveryClass}: nudge on ${channel} first, believed P(lands)=${own.landingP.toFixed(2)}; ` +
            `${bestOther.channel} kept in reserve and only tried (~${(continuationP * 100).toFixed(0)}% of the time) if ${channel} doesn't land`
          : `${recoveryClass}: nudge on ${channel}, believed P(lands)=${own.landingP.toFixed(2)} x P(then recovers)=${(own.grossRecoveryPaise / (ctx.event.amountPaise * own.landingP || 1)).toFixed(2)}`;

      return [
        candidate(
          { kind: 'contact_customer', channel, delayMs: 0, rationale },
          grossRecoveryPaise,
          costPaise,
          spamPoints,
          annoyancePricePaise,
        ),
      ];
    },
  };
}

/**
 * A recovery class's normal contact ladder -- which channels are even
 * considered, before eligibility (consent, caps, dedup, and now
 * `contactHasCausalPath`) narrows it further. Voice is included everywhere
 * on the same footing as every other channel: its own cost (Rs 15) and spam
 * price (10 points, both already established in `guardrails/compliance.ts`
 * / `sim/scenario.ts`) are what keep it from winning except where its
 * higher landing odds are worth paying for -- see `contactSpec`'s formula,
 * unchanged for voice.
 */
function ladderFor(recoveryClass: RecoveryClass, profile: LossProfile): readonly Channel[] {
  const base: readonly Channel[] =
    recoveryClass === 'CUSTOMER_ACTION_REQUIRED' || recoveryClass === 'ABANDONMENT'
      ? ['email', 'whatsapp', 'sms', 'voice']
      : ['email', 'whatsapp', 'voice'];
  return [...new Set([...base, ...profile.extraChannels])];
}

// ------------------------------------------------------------- escalate ---

const escalateSpec: ActionSpec = {
  metadata: { kind: 'escalate_human', requiresConsent: false, reversible: false },
  price({ ctx, state, recoveryClass, profile, costs, annoyancePricePaise }): readonly Candidate[] {
    const { amountPaise } = ctx.event;
    if (amountPaise < profile.humanFloorPaise) return [];
    if (ctx.history.some((h) => h.action.kind === 'escalate_human')) return [];
    if (state.blockedRules.has('MAX_HUMAN_ESCALATIONS')) return [];

    const elapsed = ctx.now - ctx.event.occurredAt;
    const canUnlock = requiresCustomerAction(recoveryClass) && profile.canRetryCharge;
    const delayMs = 60 * 60_000;

    let p: number;
    let rationale: string;
    if (canUnlock) {
      // Priced at elapsed + delayMs, not elapsed: the retry this unlocks
      // only happens after the human's call, which is itself the delay
      // already built into this candidate's own `delayMs` below -- same
      // reasoning as ASSUMED_NUDGE_RESPONSE_DELAY_MS on contact.
      const afterUnlock = believedRetryOdds(recoveryClass, elapsed + delayMs, state.attemptsSoFar, true);
      p = HUMAN_UNLOCK_LANDING_ODDS * afterUnlock;
      rationale = `${recoveryClass}: escalating to unlock the instrument -- believed P(persuades)=${HUMAN_UNLOCK_LANDING_ODDS.toFixed(2)} x P(then recovers)=${afterUnlock.toFixed(2)}`;
    } else {
      p = HUMAN_LAST_RESORT_ODDS;
      rationale = `${recoveryClass}: no modelled path for a person to unlock this class directly; priced as a small last-resort hedge (P=${p.toFixed(2)}), not a recovery channel`;
    }

    return [
      candidate(
        { kind: 'escalate_human', delayMs, rationale },
        amountPaise * p,
        costs.humanReviewCostPaise,
        SPAM_POINTS.voice,
        annoyancePricePaise,
      ),
    ];
  },
};

// ----------------------------------------------------------------- stop ---

const stopSpec: ActionSpec = {
  metadata: { kind: 'stop', requiresConsent: false, reversible: true },
  price({ annoyancePricePaise }): readonly Candidate[] {
    return [candidate(STOP('no candidate clears its cost'), 0, 0, 0, annoyancePricePaise)];
  },
};

export const CHANNEL_SPECS: Readonly<Record<Channel, ActionSpec>> = {
  email: contactSpec('email'),
  sms: contactSpec('sms'),
  whatsapp: contactSpec('whatsapp'),
  voice: contactSpec('voice'),
};

export const ACTION_REGISTRY: readonly ActionSpec[] = [
  retrySpec,
  CHANNEL_SPECS.email,
  CHANNEL_SPECS.whatsapp,
  CHANNEL_SPECS.sms,
  CHANNEL_SPECS.voice,
  escalateSpec,
  stopSpec,
];

// ------------------------------------------------- confidence-gated menu ---

/**
 * Which specs even run, given the case's confidence -- this is where Part A's
 * "more conservative, not more reckless" rule lives. Nothing here touches
 * pricing math: uncertainty changes what is OFFERED, never how a fixed set
 * is scored.
 */
function menuFor(confidence: CaseState['assessment']['confidence'], recoveryClass: RecoveryClass | undefined, profile: LossProfile): readonly ActionSpec[] {
  if (confidence === 'high') return ACTION_REGISTRY;

  if (confidence === 'medium') {
    // Full menu minus voice/escalate; those two are reintroduced by
    // `buildCandidates` below ONLY if nothing cheaper clears cost.
    return ACTION_REGISTRY.filter((s) => s.metadata.channel !== 'voice' && s.metadata.kind !== 'escalate_human');
  }

  // LOW confidence / unknown: no retry (handled inside retrySpec itself),
  // one cheap channel only, escalate framed as "route to review" rather than
  // "recover" (still uses escalateSpec's honest last-resort pricing, just
  // offered at all only from this deliberately small menu).
  const ladder = ladderFor(recoveryClass ?? 'ABANDONMENT', profile);
  const cheapChannel = ladder.includes('email') ? CHANNEL_SPECS.email : undefined;
  return [stopSpec, ...(cheapChannel ? [cheapChannel] : []), escalateSpec];
}

/**
 * Mark every candidate strictly dominated by another: costs no more, annoys
 * no more, recovers no less (gross, before cost) -- with at least one
 * strict inequality. This can never change which candidate the argmax in
 * `adaptive-agent.ts` picks: a dominator's net EV is provably >= a
 * dominated candidate's net EV by construction (net = gross - cost, and
 * the dominator's gross is >= while its cost is <=). It exists purely so
 * the "why wasn't X chosen" explanation -- in tests and in the dashboard --
 * can say "strictly worse on every axis" instead of "the numbers happened
 * to work out lower".
 */
function annotateDominance(candidates: readonly Candidate[]): Candidate[] {
  return candidates.map((c) => {
    const dominatedBy = candidates.some(
      (other) =>
        other !== c &&
        other.totalCostPaise <= c.totalCostPaise &&
        other.grossRecoveryPaise >= c.grossRecoveryPaise &&
        (other.totalCostPaise < c.totalCostPaise || other.grossRecoveryPaise > c.grossRecoveryPaise),
    );
    return dominatedBy ? { ...c, dominated: true } : c;
  });
}

/**
 * Assemble every candidate for this case, gated by its own assessment.
 * `recoveryClass` may be undefined only when confidence is LOW/unknown; in
 * that case only `stopSpec`, one cheap channel and `escalateSpec` run, none
 * of which need a recovery class to price safely.
 */
export function buildCandidates(input: Omit<PricingInput, 'recoveryClass'> & { recoveryClass: RecoveryClass | undefined }): readonly Candidate[] {
  const { state, profile, annoyancePricePaise } = input;
  const confidence = state.assessment.confidence;
  const recoveryClass = input.recoveryClass;

  if (confidence !== 'high' && confidence !== 'medium' && recoveryClass === undefined) {
    // Truly unknown: stop and escalate need no class; the one permitted
    // cheap channel is priced off a floor probability, not a class curve.
    const candidates: Candidate[] = [candidate(STOP('no candidate clears its cost'), 0, 0, 0, annoyancePricePaise)];
    const ladder = ladderFor('ABANDONMENT', profile); // placeholder only for ladder shape (whether email is on it)
    if (
      ladder.includes('email') &&
      input.ctx.event.customer.consent.email &&
      !state.channelsUsed.includes('email') &&
      !state.blockedChannels.has('email') &&
      !state.blockedRules.has('MAX_CONTACTS') &&
      !state.blockedRules.has('WEEKLY_CONTACT_CAP')
    ) {
      const floorP = 0.05; // same conservative floor as the escalate last-resort hedge; not a class curve
      const gain = input.ctx.event.amountPaise * floorP;
      candidates.push(
        candidate(
          {
            kind: 'contact_customer',
            channel: 'email',
            delayMs: 0,
            rationale: `unrecognised failure: no class to price against, so a single cheap check-in priced off a conservative floor (P=${floorP.toFixed(2)}), not a curve`,
          },
          gain,
          input.costs.contactCostPaise.email,
          SPAM_POINTS.email,
          annoyancePricePaise,
        ),
      );
    }
    if (input.ctx.event.amountPaise >= input.profile.humanFloorPaise) {
      candidates.push(
        candidate(
          {
            kind: 'escalate_human',
            delayMs: 60 * 60_000,
            rationale: `unrecognised failure on a case large enough to warrant a human look; not priced as a recovery channel`,
          },
          input.ctx.event.amountPaise * HUMAN_LAST_RESORT_ODDS,
          input.costs.humanReviewCostPaise,
          SPAM_POINTS.voice,
          annoyancePricePaise,
        ),
      );
    }
    return annotateDominance(candidates);
  }

  if (recoveryClass === undefined) {
    return [candidate(STOP('no candidate clears its cost'), 0, 0, 0, annoyancePricePaise)];
  }

  const menu = menuFor(confidence, recoveryClass, profile);
  const fullInput: PricingInput = { ...input, recoveryClass };
  let candidates = menu.flatMap((spec) => spec.price(fullInput));
  if (candidates.length === 0) candidates = [candidate(STOP('no candidate clears its cost'), 0, 0, 0, annoyancePricePaise)];

  if (confidence === 'medium') {
    const bestNonStop = candidates
      .filter((c) => c.action.kind !== 'stop')
      .reduce((a, b) => (b.expectedValuePaise > (a?.expectedValuePaise ?? Number.NEGATIVE_INFINITY) ? b : a), undefined as Candidate | undefined);
    if (!bestNonStop || bestNonStop.expectedValuePaise <= 0) {
      // Nothing cheaper clears cost -- voice and human escalation are the
      // last things left to try, so bring them back into the running.
      const suppressed = ACTION_REGISTRY.filter(
        (s) => s.metadata.channel === 'voice' || s.metadata.kind === 'escalate_human',
      );
      candidates = [...candidates, ...suppressed.flatMap((spec) => spec.price(fullInput))];
    }
  }

  return annotateDominance(candidates);
}
