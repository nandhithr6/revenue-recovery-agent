import { useMemo } from 'react';
import type { CaseTrace, InspectableCase } from './types';

/**
 * The one moment meant to answer "why adaptive, not just a better schedule?"
 * in a single glance -- a REAL case, found by searching the actual traces
 * `eval/run-all.ts:buildInspectableCases` already exported for the case
 * inspector (same data, same run, same seed), not written for this page.
 *
 * Selection is mechanical: among cases where `fixed-dunning` failed to
 * recover and `agent-adaptive` did, on the same case with the same
 * randomness, pick the one with the largest amount at risk -- the strongest
 * real example the cohort actually produced, not a cherry-picked script.
 */

const inr = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

function firstExecuted(trace: CaseTrace | undefined): CaseTrace['steps'][number] | undefined {
  return trace?.steps.find((s) => s.outcome === 'executed' || s.outcome === 'stopped');
}

function actionLabel(step: CaseTrace['steps'][number] | undefined): string {
  if (!step) return '—';
  const { kind, channel } = step.decided;
  if (kind === 'retry_payment') return 'Retry the payment';
  if (kind === 'contact_customer') return `Message the customer${channel ? ` · ${channel}` : ''}`;
  if (kind === 'escalate_human') return 'Escalate to a human';
  if (kind === 'wait') return 'Wait, then reconsider';
  return 'Stop';
}

interface Pick {
  readonly ev: InspectableCase;
  readonly fixed: CaseTrace;
  readonly adaptive: CaseTrace;
}

/** Does some step in `adaptive` carry a real, priced, rejected candidate
 *  matching `fixedFirst`'s exact move -- a genuine head-to-head EV
 *  comparison, not just two different actions that happened to both occur? */
function hasHeadToHeadComparison(adaptive: CaseTrace, fixedFirst: CaseTrace['steps'][number]): boolean {
  return adaptive.steps.some(
    (step) =>
      step.candidates?.some(
        (c) => !c.chosen && c.kind === fixedFirst.decided.kind && c.channel === fixedFirst.decided.channel,
      ) ?? false,
  );
}

function pickCase(cases: readonly InspectableCase[]): Pick | undefined {
  let bestWithComparison: Pick | undefined;
  let bestAny: Pick | undefined;
  for (const ev of cases) {
    const fixed = ev.traces.find((t) => t.strategyId === 'fixed-dunning');
    const adaptive = ev.traces.find((t) => t.strategyId === 'agent-adaptive');
    if (!fixed || !adaptive) continue;
    if (fixed.recovered || !adaptive.recovered) continue;
    const fixedFirst = firstExecuted(fixed);
    const adaptiveFirst = firstExecuted(adaptive);
    if (!fixedFirst || !adaptiveFirst) continue;
    const sameAction =
      fixedFirst.decided.kind === adaptiveFirst.decided.kind && fixedFirst.decided.channel === adaptiveFirst.decided.channel;
    if (sameAction) continue; // want a genuine action difference, not just a timing coincidence

    const candidate: Pick = { ev, fixed, adaptive };
    if (!bestAny || ev.event.amountPaise > bestAny.ev.event.amountPaise) bestAny = candidate;
    if (hasHeadToHeadComparison(adaptive, fixedFirst)) {
      if (!bestWithComparison || ev.event.amountPaise > bestWithComparison.ev.event.amountPaise) {
        bestWithComparison = candidate;
      }
    }
  }
  // Prefer a case where the priced comparison can be shown verbatim -- a
  // stronger, more principled story -- and only fall back to any qualifying
  // case (still real, just explained via the agent's own rationale text
  // instead of a side-by-side EV number) if none exists.
  return bestWithComparison ?? bestAny;
}

export function WhyAdaptive({ cases }: { cases: readonly InspectableCase[] }) {
  const pick = useMemo(() => pickCase(cases), [cases]);
  if (!pick) return null;

  const { ev, fixed, adaptive } = pick;
  const fixedFirst = firstExecuted(fixed);
  const adaptiveFirst = firstExecuted(adaptive);
  // Search every step the adaptive agent priced (not just the first) for
  // one where the SAME candidate fixed dunning's first move used was also
  // on the table and rejected -- the real, apples-to-apples comparison,
  // wherever in the trace it actually happened.
  let chosenCandidate: NonNullable<CaseTrace['steps'][number]['candidates']>[number] | undefined;
  let rejectedCandidate: NonNullable<CaseTrace['steps'][number]['candidates']>[number] | undefined;
  for (const step of adaptive.steps) {
    if (!step.candidates || step.candidates.length === 0) continue;
    const reject = step.candidates.find(
      (c) => !c.chosen && c.kind === fixedFirst?.decided.kind && c.channel === fixedFirst?.decided.channel,
    );
    if (reject) {
      rejectedCandidate = reject;
      chosenCandidate = step.candidates.find((c) => c.chosen);
      break;
    }
  }

  return (
    <div className="why-adaptive">
      <div className="why-adaptive-head">
        <span className="why-adaptive-tag">REAL CASE · {ev.event.id}</span>
        <span className="why-adaptive-amt">{inr(ev.event.amountPaise)}</span>
        <span className="why-adaptive-class">{ev.event.recoveryClass.replace(/_/g, ' ').toLowerCase()}</span>
      </div>

      <div className="why-adaptive-grid">
        <div className="why-adaptive-col why-adaptive-lost">
          <span className="why-adaptive-strategy">Fixed dunning</span>
          <span className="why-adaptive-action">{actionLabel(fixedFirst)}</span>
          <span className="why-adaptive-result why-adaptive-fail">
            ✕ recovered nothing — {fixed.stoppedReason}
          </span>
        </div>
        <div className="why-adaptive-vs">vs</div>
        <div className="why-adaptive-col why-adaptive-won">
          <span className="why-adaptive-strategy">Adaptive agent</span>
          <span className="why-adaptive-action">{actionLabel(adaptiveFirst)}</span>
          <span className="why-adaptive-result why-adaptive-success">
            ✓ recovered {inr(adaptive.recoveredPaise)}
          </span>
        </div>
      </div>

      {chosenCandidate && rejectedCandidate ? (
        <p className="why-adaptive-econ">
          <b>Why it was economically better:</b> priced at{' '}
          {inr(chosenCandidate.expectedValuePaise)} expected value vs{' '}
          {inr(rejectedCandidate.expectedValuePaise)} for the fixed-schedule move — the same
          candidate comparison the agent actually ran, not a summary written after the fact.
        </p>
      ) : (
        adaptiveFirst && (
          <p className="why-adaptive-econ">
            <b>The agent's own reasoning, verbatim:</b> {adaptiveFirst.decided.rationale}
          </p>
        )
      )}
    </div>
  );
}
