import { useMemo, useState } from 'react';
import { seriesColor } from './charts';
import type { InspectableCase, TraceStep } from './types';

/**
 * The case inspector.
 *
 * A scoreboard asks to be believed. This asks to be checked: pick any case, and
 * for every decision see the exact inputs the policy was given, the action it
 * returned in its own words, and the guardrail verdict that followed.
 *
 * The left column is a projection of `CaseContext` and nothing else -- if the
 * agent could not see it, it is not shown. The simulator's ground-truth recovery
 * odds never appear here, because the agent never gets them either.
 */

const inr = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

const clock = (ms: number): string =>
  new Date(ms).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

const STRATEGY_ORDER = ['do-nothing', 'naive-retry', 'fixed-dunning', 'agent-rules'];
const STRATEGY_LABEL: Record<string, string> = {
  'do-nothing': 'Do nothing',
  'naive-retry': 'Naive retry',
  'fixed-dunning': 'Fixed dunning',
  'agent-rules': 'Reason-aware agent',
};

const CLASS_PLAIN: Record<string, string> = {
  TRANSIENT_INFRA: 'a bank or gateway was down',
  TRANSIENT_FUNDS: 'not enough money in the account',
  CUSTOMER_ACTION_REQUIRED: 'the card or UPI ID is unusable',
  ABANDONMENT: 'the customer walked away',
  AUTH_FAILURE: 'wrong OTP or CVV',
  HARD_DECLINE: 'the bank refused outright',
};

function formatDelay(ms: number): string {
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${(ms / 86_400_000).toFixed(1)} days`;
}

function humanAction(step: TraceStep): string {
  const { kind, channel } = step.decided;
  if (kind === 'retry_payment') return 'Try the payment again';
  if (kind === 'contact_customer') return `Message the customer on ${channel}`;
  if (kind === 'escalate_human') return 'Hand it to a person';
  return 'Stop working this case';
}

/** One decision, in three columns: what it saw, what it chose, what happened. */
function Step({ step }: { step: TraceStep }) {
  const { seen, decided, verdict } = step;

  return (
    <div className="step">
      <div className="step-n">
        <span>{String(step.step + 1).padStart(2, '0')}</span>
        <time>{clock(step.at)}</time>
      </div>

      <div className="panel">
        <h4>What the agent could see</h4>
        <dl>
          <div>
            <dt>Razorpay reason</dt>
            <dd className="mono">{seen.reasonCode ?? '—'}</dd>
          </div>
          <div>
            <dt>It worked out</dt>
            <dd className="mono">{seen.derivedRecoveryClass}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>{inr(seen.amountPaise)}</dd>
          </div>
          <div>
            <dt>Hours since failure</dt>
            <dd>{seen.hoursSinceFailure}</dd>
          </div>
          <div>
            <dt>Tried so far</dt>
            <dd>
              {seen.retriesSoFar} retries, {seen.contactsSoFar} messages
            </dd>
          </div>
          <div>
            <dt>Allowed channels</dt>
            <dd>{seen.consentedChannels.join(', ') || 'none'}</dd>
          </div>
          {seen.dndRegistered && (
            <div>
              <dt>DND</dt>
              <dd>registered</dd>
            </div>
          )}
          {seen.rulesAlreadyHit.length > 0 && (
            <div>
              <dt>Rules already hit</dt>
              <dd className="mono">{seen.rulesAlreadyHit.join(', ')}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="panel">
        <h4>What it decided</h4>
        <p className="decision">{humanAction(step)}</p>
        {decided.delayMs > 0 && <p className="when">waits {formatDelay(decided.delayMs)} first</p>}
        <blockquote>{decided.rationale}</blockquote>
      </div>

      <div className="panel">
        <h4>What the guardrails said</h4>
        <span className={`tag ${step.outcome}`}>{step.outcome}</span>
        {verdict.rule ? (
          <>
            <p className="rulename mono">{verdict.rule}</p>
            <p className="ruletext">{verdict.explanation}</p>
            {verdict.notBefore && (
              <p className="ruletext">
                Rescheduled to <strong>{clock(verdict.notBefore)}</strong>.
              </p>
            )}
          </>
        ) : (
          <p className="ruletext">
            {step.outcome === 'executed'
              ? step.succeeded
                ? 'Allowed, and it worked.'
                : 'Allowed. It ran and did not work.'
              : 'Allowed.'}
          </p>
        )}
        {(step.costPaise > 0 || step.spamPoints > 0) && (
          <p className="cost mono">
            cost {inr(step.costPaise)} · annoyance {step.spamPoints}
          </p>
        )}
      </div>
    </div>
  );
}

export function CaseInspector({ cases }: { cases: readonly InspectableCase[] }) {
  const classes = useMemo(
    () => [...new Set(cases.map((c) => c.event.recoveryClass))].sort(),
    [cases],
  );
  const [cls, setCls] = useState<string>(classes[0] ?? '');
  const inClass = useMemo(
    () => cases.filter((c) => c.event.recoveryClass === cls),
    [cases, cls],
  );
  const [caseId, setCaseId] = useState<string>(inClass[0]?.event.id ?? '');

  const current =
    inClass.find((c) => c.event.id === caseId) ?? inClass[0] ?? cases[0];

  if (!current) return <p className="note">No cases exported.</p>;

  const agentTrace = current.traces.find((t) => t.strategyId === 'agent-rules');
  const ordered = [...current.traces].sort(
    (a, b) => STRATEGY_ORDER.indexOf(a.strategyId) - STRATEGY_ORDER.indexOf(b.strategyId),
  );

  return (
    <div>
      <div className="inspector-controls">
        <div className="scenarios" role="group" aria-label="Failure class">
          {classes.map((c) => (
            <button
              key={c}
              aria-pressed={c === cls}
              onClick={() => {
                setCls(c);
                const first = cases.find((x) => x.event.recoveryClass === c);
                if (first) setCaseId(first.event.id);
              }}
            >
              {c.replace(/_/g, ' ').toLowerCase()}
            </button>
          ))}
        </div>

        <label className="picker">
          <span>Case</span>
          <select value={current.event.id} onChange={(e) => setCaseId(e.target.value)}>
            {inClass.map((c) => (
              <option key={c.event.id} value={c.event.id}>
                {c.event.id} · {inr(c.event.amountPaise)} · {c.event.reasonCode}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="case-head">
        <p>
          <strong className="mono">{current.event.id}</strong> — {inr(current.event.amountPaise)} by{' '}
          {current.event.method.toUpperCase()}, failed with{' '}
          <strong className="mono">{current.event.reasonCode}</strong>, which means{' '}
          <strong>{CLASS_PLAIN[current.event.recoveryClass] ?? current.event.recoveryClass}</strong>.
          Customer consented to {Object.entries(current.event.customer.consent)
            .filter(([, v]) => v)
            .map(([k]) => k)
            .join(', ') || 'nothing'}
          {current.event.customer.dndRegistered ? ', and is on the DND registry' : ''}.
        </p>
      </div>

      <h3 className="sub-h">What each strategy did with it</h3>
      <div className="race">
        {ordered.map((t) => (
          <div
            key={t.strategyId}
            className={`lane ${t.strategyId === 'agent-rules' ? 'lane-lead' : ''}`}
          >
            <div className="lane-head">
              <i style={{ background: seriesColor(STRATEGY_ORDER.indexOf(t.strategyId)) }} aria-hidden />
              {STRATEGY_LABEL[t.strategyId] ?? t.strategyId}
            </div>
            <div className={`lane-result ${t.recovered ? 'won' : 'lost'}`}>
              {t.recovered ? `recovered ${inr(t.recoveredPaise)}` : 'recovered nothing'}
            </div>
            <ul className="lane-steps">
              {t.steps
                .filter((s) => s.outcome !== 'stopped')
                .map((s) => (
                  <li key={s.step} className={s.outcome}>
                    {humanAction(s)}
                    {s.outcome === 'executed' && s.succeeded === false ? ' — no effect' : ''}
                    {s.outcome === 'deferred' ? ` — held back (${s.verdict.rule})` : ''}
                    {s.outcome === 'blocked' ? ` — refused (${s.verdict.rule})` : ''}
                  </li>
                ))}
              {t.steps.filter((s) => s.outcome !== 'stopped').length === 0 && (
                <li className="stopped">did nothing</li>
              )}
            </ul>
            <div className="lane-foot mono">
              spent {inr(t.costPaise)} · annoyance {t.spamPoints}
            </div>
          </div>
        ))}
      </div>

      {agentTrace && (
        <>
          <h3 className="sub-h">Every decision the agent made, and why</h3>
          <p className="note" style={{ marginLeft: 0 }}>
            The left column is exactly what the policy was given — no ground truth, no recovery
            odds, nothing the real system would not have. The middle is what it returned, quoted
            verbatim. The right is the guardrail ruling on it.
          </p>
          <div className="steps">
            {agentTrace.steps.map((s) => (
              <Step key={s.step} step={s} />
            ))}
          </div>
          <p className="closing mono">
            Closed: {agentTrace.stoppedReason}
          </p>
        </>
      )}
    </div>
  );
}
