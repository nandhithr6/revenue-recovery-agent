import { lookupReason, type RecoveryClass } from '../domain/failure-taxonomy.js';
import {
  DAY,
  type Channel,
  type CustomerSignal,
  type LossEvent,
  type Paise,
  type Timestamp,
} from '../domain/types.js';
import {
  gate,
  DEFAULT_GUARDRAILS,
  MAX_DEFERRALS_PER_ACTION,
  MAX_DEFERRAL_SPAN_MS,
  RETRY_SPAM_POINTS,
  SPAM_POINTS,
  type GuardrailConfig,
} from '../guardrails/index.js';
import { Ledger } from '../ledger/ledger.js';
import type { CaseContext, HistoryEntry, Strategy } from '../policies/types.js';
import { NUDGE_EFFECTIVENESS, recoversViaLink, recoveryOdds } from '../sim/recovery-model.js';
import { Rng } from '../sim/rng.js';
import type { CostModel } from '../sim/scenario.js';
import { drawVoiceSignal } from '../sim/voice-signal-model.js';
import { captureAction, captureView, type CandidateSummary, type TraceSink } from './trace.js';

/** Which structured voice signals represent real, positive engagement --
 *  as opposed to a call that connected but yielded nothing (or worse). */
function isPositiveSignal(signal: CustomerSignal): boolean {
  return (
    signal.kind === 'promise_to_pay' ||
    signal.kind === 'funds_available_now' ||
    signal.kind === 'instrument_fixed'
  );
}

/**
 * Executes a strategy against simulated ground truth, through the guardrails,
 * and records everything to a ledger.
 *
 * The engine is the only component that sees ground truth (recovery odds,
 * whether a customer would respond to a nudge). Policies see `CaseContext` and
 * nothing more.
 *
 * Critically, the engine is also the only component that can execute an action,
 * and it will not do so without an `allow` verdict from the gate. That is what
 * makes the policy/guardrail separation structural: there is no back door.
 */

/**
 * The simulation's own backstop, separate from the agent's stopping rules. Even
 * a policy that ignores every hint cannot spin forever.
 */
const MAX_STEPS_PER_CASE = 32;
const MAX_HORIZON_MS = 14 * DAY;

export interface CaseResult {
  readonly eventId: string;
  readonly amountPaise: Paise;
  /** Payment method, so results can be split UPI vs card. */
  readonly method: string;
  readonly recovered: boolean;
  readonly recoveredPaise: Paise;
  readonly retries: number;
  readonly contacts: number;
  readonly humanEscalations: number;
  readonly costPaise: Paise;
  /** Customer-annoyance score accumulated on this case. */
  readonly spamPoints: number;
  /** Actions a guardrail refused outright. */
  readonly blockedActions: number;
  /** Actions a guardrail postponed rather than dropped. */
  readonly deferrals: number;
  /** Network fees and auth-rate damage from retrying hard declines. */
  readonly issuerPenaltyPaise: Paise;
  readonly history: readonly HistoryEntry[];
  /** Ground-truth class, for reporting only. Never shown to a policy. */
  readonly recoveryClass: RecoveryClass | 'UNKNOWN';
  readonly stoppedReason: string;
}

function classOf(event: LossEvent): RecoveryClass | 'UNKNOWN' {
  if (!event.reasonCode) return 'UNKNOWN';
  return lookupReason(event.reasonCode)?.recoveryClass ?? 'UNKNOWN';
}

export function runCase(
  event: LossEvent,
  strategy: Strategy,
  costs: CostModel,
  rng: Rng,
  ledger: Ledger,
  guardrails: GuardrailConfig = DEFAULT_GUARDRAILS,
  /** Opt-in. Omitted on hot paths so tracing costs nothing when unused. */
  trace?: TraceSink,
  /**
   * Opt-in, and only meaningful alongside `trace`: computes the full priced
   * candidate comparison for display (see
   * `policies/adaptive-agent.ts:explain`), called at the SAME point `seen`
   * is captured -- before `strategy.decide(ctx)` runs, on the identical
   * `ctx`. Never affects the actual decision; a strategy that ignores this
   * parameter (every one of them, since `decide()` never receives it)
   * behaves exactly as it always has. Undefined for every strategy except
   * where the caller explicitly wants the reasoning shown, e.g. the
   * dashboard's live feed.
   */
  candidateHook?: (ctx: CaseContext) => readonly CandidateSummary[] | undefined,
): CaseResult {
  const recoveryClass = classOf(event);
  const history: HistoryEntry[] = [];
  const channelsUsed: Channel[] = [];

  let now: Timestamp = event.occurredAt;
  let retries = 0;
  let contacts = 0;
  let humanEscalations = 0;
  let costPaise = 0;
  let spamPoints = 0;
  let blockedActions = 0;
  let deferrals = 0;
  let issuerPenaltyPaise = 0;
  let customerActed = false;
  let recovered = false;
  let stoppedReason = 'engine step limit reached';

  for (let step = 0; step < MAX_STEPS_PER_CASE; step++) {
    const ctx: CaseContext = {
      event,
      now,
      history,
      attemptCount: retries,
      contactCount: contacts,
      channelsUsed,
    };

    // Snapshot BEFORE deciding, so the trace records the inputs the policy
    // actually had rather than the state afterwards.
    const seen = trace ? captureView(ctx) : undefined;
    const candidates = trace && candidateHook ? candidateHook(ctx) : undefined;
    const action = strategy.decide(ctx);

    if (action.kind === 'wait') {
      // Pause, not stop: advance the clock and loop back to decide() again,
      // rather than ending the case. No cost, no customer contact, no
      // guardrail applies -- there is nothing here for a guardrail to permit
      // or refuse.
      now += Math.max(0, action.delayMs);
      ledger.append({
        caseId: event.id,
        at: now,
        actionKind: 'wait',
        channel: undefined,
        outcome: 'executed',
        succeeded: undefined,
        rationale: action.rationale,
        rule: undefined,
        explanation: undefined,
        deferredTo: undefined,
        costPaise: 0,
        spamPoints: 0,
        ...(candidates ? { candidates } : {}),
      });
      if (trace && seen) {
        trace.push({
          at: now,
          seen,
          decided: captureAction(action),
          verdict: { kind: 'allow' },
          outcome: 'executed',
          costPaise: 0,
          spamPoints: 0,
          ...(candidates ? { candidates } : {}),
        });
      }
      if (now - event.occurredAt > MAX_HORIZON_MS) {
        stoppedReason = 'recovery horizon exceeded while waiting';
        break;
      }
      continue;
    }

    if (action.kind === 'stop') {
      stoppedReason = action.rationale;
      ledger.append({
        caseId: event.id,
        at: now,
        actionKind: 'stop',
        channel: undefined,
        outcome: 'stopped',
        succeeded: undefined,
        rationale: action.rationale,
        rule: undefined,
        explanation: undefined,
        deferredTo: undefined,
        costPaise: 0,
        spamPoints: 0,
        ...(candidates ? { candidates } : {}),
      });
      if (trace && seen) {
        trace.push({
          at: now,
          seen,
          decided: captureAction(action),
          verdict: { kind: 'allow' },
          outcome: 'stopped',
          costPaise: 0,
          spamPoints: 0,
          ...(candidates ? { candidates } : {}),
        });
      }
      break;
    }

    // ---- Guardrails, with a bounded deferral loop. ----------------------
    //
    // A deferral is not a failure. A message that would land inside quiet
    // hours is queued for the next permitted window, which is the difference
    // between a compliant agent and one that simply loses the revenue.

    let scheduledAt = now + Math.max(0, action.delayMs);
    let verdict = gate(
      { action, customer: event.customer, at: scheduledAt, caseOpenedAt: event.occurredAt, history },
      guardrails,
    );

    let deferralsHere = 0;
    while (
      verdict.kind === 'defer' &&
      deferralsHere < MAX_DEFERRALS_PER_ACTION &&
      verdict.notBefore - scheduledAt <= MAX_DEFERRAL_SPAN_MS
    ) {
      ledger.append({
        caseId: event.id,
        at: scheduledAt,
        actionKind: action.kind,
        channel: action.channel,
        outcome: 'deferred',
        succeeded: undefined,
        rationale: action.rationale,
        rule: verdict.rule,
        explanation: verdict.explanation,
        deferredTo: verdict.notBefore,
        costPaise: 0,
        spamPoints: 0,
        ...(candidates ? { candidates } : {}),
      });
      if (trace && seen) {
        trace.push({
          at: scheduledAt,
          seen,
          decided: captureAction(action),
          verdict: {
            kind: 'defer',
            rule: verdict.rule,
            explanation: verdict.explanation,
            notBefore: verdict.notBefore,
          },
          outcome: 'deferred',
          costPaise: 0,
          spamPoints: 0,
          ...(candidates ? { candidates } : {}),
        });
      }
      deferrals += 1;
      deferralsHere += 1;
      scheduledAt = verdict.notBefore;
      verdict = gate(
        { action, customer: event.customer, at: scheduledAt, caseOpenedAt: event.occurredAt, history },
        guardrails,
      );
    }

    if (verdict.kind !== 'allow') {
      // Either a hard block, or a deferral we refused to keep chasing.
      const rule = verdict.kind === 'block' ? verdict.rule : 'DEFERRAL_LIMIT';
      const explanation =
        verdict.kind === 'block'
          ? verdict.explanation
          : 'Action deferred too many times or too far into the future; abandoned.';

      history.push({ at: scheduledAt, action, succeeded: false, blockedBy: rule });
      blockedActions += 1;
      ledger.append({
        caseId: event.id,
        at: scheduledAt,
        actionKind: action.kind,
        channel: action.channel,
        outcome: 'blocked',
        succeeded: false,
        rationale: action.rationale,
        rule,
        explanation,
        deferredTo: undefined,
        costPaise: 0,
        spamPoints: 0,
        ...(candidates ? { candidates } : {}),
      });
      if (trace && seen) {
        trace.push({
          at: scheduledAt,
          seen,
          decided: captureAction(action),
          verdict: { kind: 'block', rule, explanation },
          outcome: 'blocked',
          succeeded: false,
          costPaise: 0,
          spamPoints: 0,
          ...(candidates ? { candidates } : {}),
        });
      }
      // The clock still advances: the agent tried, and time passed.
      now = scheduledAt;
      continue;
    }

    now = scheduledAt;
    if (now - event.occurredAt > MAX_HORIZON_MS) {
      stoppedReason = 'recovery horizon exceeded';
      break;
    }

    // ---- Execute. -------------------------------------------------------

    let succeeded = false;
    let actionCost = 0;
    let actionSpam = 0;
    let stepSignal: CustomerSignal | undefined;

    switch (action.kind) {
      case 'retry_payment': {
        const elapsed = now - event.occurredAt;
        // Ground truth, applied identically to every strategy: where nothing was
        // ever authorised, re-attempting the charge cannot succeed. An abandoned
        // checkout has no mandate behind it and an invoice is not an instrument.
        // A strategy that retries them anyway pays the cost and gets nothing,
        // which is exactly what would happen on real rails.
        const odds =
          recoveryClass === 'UNKNOWN' || recoversViaLink(event.lossType)
            ? { probability: 0 }
            : recoveryOdds(recoveryClass, elapsed, retries, customerActed);
        succeeded = rng.chance(odds.probability);
        retries += 1;
        actionCost = costs.retryCostPaise;
        // Retrying an instrument the issuer refused with prejudice is not merely
        // futile, it is billed. See CostModel.hardDeclineRetryPenaltyPaise.
        if (recoveryClass === 'HARD_DECLINE') {
          actionCost += costs.hardDeclineRetryPenaltyPaise;
          issuerPenaltyPaise += costs.hardDeclineRetryPenaltyPaise;
        }
        actionSpam = RETRY_SPAM_POINTS;
        if (succeeded) recovered = true;
        break;
      }

      case 'contact_customer': {
        const channel = action.channel;
        if (!channel) throw new Error('contact_customer reached execution without a channel');
        contacts += 1;
        actionCost = costs.contactCostPaise[channel];
        actionSpam = SPAM_POINTS[channel];
        if (!channelsUsed.includes(channel)) channelsUsed.push(channel);

        if (channel === 'voice' && recoveryClass !== 'UNKNOWN') {
          // Voice produces a STRUCTURED observation, not a plain landed/not
          // boolean -- ground truth for which is `sim/voice-signal-model.ts`,
          // read only here, never by a policy. `succeeded` is derived from
          // it (see `isPositiveSignal`) purely so every other piece of code
          // that already reads `succeeded` on any channel keeps working
          // unchanged for voice too.
          const signal = drawVoiceSignal(recoveryClass, rng);
          stepSignal = signal;
          if (isPositiveSignal(signal)) {
            customerActed = true;
            succeeded = true;
            if (recoversViaLink(event.lossType)) {
              const odds = recoveryOdds(recoveryClass, now - event.occurredAt, retries, true);
              if (rng.chance(odds.probability)) recovered = true;
            }
          }
        } else {
          // A nudge may persuade the customer to act. For loss types with an
          // instrument to fix, that unlocks a later retry; for link-recoverable
          // ones, acting IS the payment.
          const effectiveness = NUDGE_EFFECTIVENESS[channel] ?? 0;
          if (event.customer.respondsToNudge && rng.chance(effectiveness)) {
            customerActed = true;
            succeeded = true;

            // Where there is no charge to re-attempt, acting on the nudge IS the
            // payment: the customer follows the link and pays. The class curve
            // still decides whether that payment goes through.
            if (recoversViaLink(event.lossType) && recoveryClass !== 'UNKNOWN') {
              const odds = recoveryOdds(recoveryClass, now - event.occurredAt, retries, true);
              if (rng.chance(odds.probability)) recovered = true;
            }
          }
        }
        break;
      }

      case 'escalate_human': {
        humanEscalations += 1;
        actionCost = costs.humanReviewCostPaise;
        actionSpam = SPAM_POINTS.voice;
        if (event.customer.respondsToNudge && rng.chance(0.62)) {
          customerActed = true;
          succeeded = true;
        }
        break;
      }
    }

    costPaise += actionCost;
    spamPoints += actionSpam;
    history.push(
      stepSignal
        ? { at: now, action, succeeded, signal: stepSignal }
        : { at: now, action, succeeded },
    );

    ledger.append({
      caseId: event.id,
      at: now,
      actionKind: action.kind,
      channel: action.channel,
      outcome: 'executed',
      succeeded,
      rationale: action.rationale,
      rule: undefined,
      explanation: undefined,
      deferredTo: undefined,
      costPaise: actionCost,
      spamPoints: actionSpam,
      ...(stepSignal ? { signal: stepSignal } : {}),
      ...(candidates ? { candidates } : {}),
    });

    if (trace && seen) {
      trace.push({
        at: now,
        seen,
        decided: captureAction(action),
        verdict: { kind: 'allow' },
        outcome: 'executed',
        succeeded,
        costPaise: actionCost,
        spamPoints: actionSpam,
        ...(stepSignal ? { signal: stepSignal } : {}),
        ...(candidates ? { candidates } : {}),
      });
    }

    if (recovered) {
      stoppedReason = 'recovered';
      break;
    }
  }

  return {
    eventId: event.id,
    amountPaise: event.amountPaise,
    method: event.method,
    recovered,
    recoveredPaise: recovered ? event.amountPaise : 0,
    retries,
    contacts,
    humanEscalations,
    costPaise,
    spamPoints,
    blockedActions,
    deferrals,
    issuerPenaltyPaise,
    history,
    recoveryClass,
    stoppedReason,
  };
}

export interface RunResult {
  readonly strategyId: string;
  readonly strategyName: string;
  readonly cases: readonly CaseResult[];
  readonly ledger: Ledger;
}

export function runCohort(
  events: readonly LossEvent[],
  strategy: Strategy,
  costs: CostModel,
  seed: number,
  guardrails: GuardrailConfig = DEFAULT_GUARDRAILS,
): RunResult {
  // Each strategy gets an identically seeded RNG, so differences in outcome are
  // caused by decisions, not by luck.
  const rng = new Rng(seed);
  const ledger = new Ledger();
  const cases = events.map((e) => runCase(e, strategy, costs, rng, ledger, guardrails));
  return { strategyId: strategy.id, strategyName: strategy.name, cases, ledger };
}
