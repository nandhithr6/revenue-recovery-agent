import { useMemo, useState } from 'react';
import { strategyColor } from './charts';
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

const CANDIDATE_LABEL: Record<string, string> = {
  retry_payment: 'Retry',
  contact_customer: 'Message',
  escalate_human: 'Human escalation',
  stop: 'Stop',
};

const STRATEGY_ORDER = ['do-nothing', 'naive-retry', 'fixed-dunning', 'agent-adaptive', 'agent-rules'];
const STRATEGY_LABEL: Record<string, string> = {
  'do-nothing': 'Do nothing',
  'naive-retry': 'Naive retry',
  'fixed-dunning': 'Fixed dunning',
  'agent-adaptive': 'Adaptive agent',
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

/**
 * Plain-English reading of `DebitStatus` (`domain/types.ts`) -- most useful
 * exactly when a case recovered nothing: "recovered nothing" reads very
 * differently once it's clear the customer was never actually charged for
 * the failed attempt, versus a genuinely unresolved original authorisation.
 * `debited` is listed for completeness but never occurs in this simulator
 * (see `sim/generator.ts:deriveDebitStatus`'s own honesty note) -- every
 * loss type here is a payment that never captured.
 */
const DEBIT_STATUS_NOTE: Record<string, string> = {
  no_debit: 'No money was ever taken from the customer for this attempt — the bank/network gave a definitive refusal, or the customer never reached authorisation at all.',
  uncertain: 'Whether the original attempt actually debited the customer is unconfirmed — the agent holds the first retry back for a verification window before trying again, specifically to avoid a duplicate charge.',
  debited: 'Money was taken and this concerns a reversal, not a fresh charge attempt.',
};

function formatDelay(ms: number): string {
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${(ms / 86_400_000).toFixed(1)} days`;
}

function humanAction(step: TraceStep): string {
  const { kind, channel } = step.decided;
  if (kind === 'retry_payment') return 'Try the payment again';
  if (kind === 'contact_customer') return channel === 'voice' ? 'Call the customer' : `Message the customer on ${channel}`;
  if (kind === 'escalate_human') return 'Hand it to a person';
  if (kind === 'wait') return 'Wait, then reconsider';
  return 'Stop working this case';
}

const CONFIDENCE_LABEL: Record<string, string> = { high: 'high confidence', medium: 'medium confidence', low: 'low confidence' };
const STATUS_LABEL: Record<string, string> = { known: 'known', inferred: 'inferred', unknown: 'unknown' };

export const SIGNAL_LABEL: Record<string, string> = {
  promise_to_pay: '"I\'ll pay soon" — treated as a commitment, agent waits then rechecks',
  funds_available_now: '"I can pay now" — instrument/funds issue resolved, agent retries',
  instrument_fixed: '"That\'s fixed now" — agent retries immediately',
  disputes_charge: 'Customer disputes the charge — agent stops rather than push further',
  refused: 'Customer declined to engage further — agent stops',
  no_answer: "Call didn't connect — no new information, agent continues as before",
};

/**
 * Hinglish rendering of the SAME structured `CustomerSignal`, for the
 * Hinglish voice-recovery track direction -- a second, independently
 * written rendering of exactly the signal `SIGNAL_LABEL` above already
 * renders in English, same purpose (readability for a human looking at the
 * trace), same source of truth (`step.signal.kind`, the only thing any
 * policy or the engine itself ever sees). No fabricated line for
 * `no_answer`: there was no conversation, only an unanswered call.
 *
 * Deliberately hand-written here rather than imported from
 * `src/domain/hinglish-voice.ts`: the dashboard reads only the JSON bundle
 * `eval:all` produces and never imports simulation/policy source, the same
 * boundary every other dictionary in this file (`SIGNAL_LABEL`,
 * `CLASS_LABEL`, `CLASS_PLAIN`, ...) already keeps.
 */
export const HINGLISH_OPENING = {
  hinglish: 'Namaste! Aapka payment complete nahi ho paya tha, main isi baare mein call kar rahi/raha hoon.',
  english: "Hello! Your payment didn't go through, I'm calling about that.",
};

export const HINGLISH_CUSTOMER_LINE: Record<string, { hinglish: string; english: string }> = {
  promise_to_pay: {
    hinglish: 'Haan haan, main jaldi hi pay kar dunga, thoda time dijiye.',
    english: "Yes yes, I'll pay soon, just give me some time.",
  },
  funds_available_now: {
    hinglish: 'Ab account mein paisa aa gaya hai, aap abhi try kar sakte hain.',
    english: 'The funds are in my account now, you can try again.',
  },
  instrument_fixed: {
    hinglish: 'Maine card/UPI theek kar diya hai, ab chalega.',
    english: "I've fixed the card/UPI, it'll work now.",
  },
  disputes_charge: {
    hinglish: 'Yeh charge maine kiya hi nahi tha, isko cancel kijiye.',
    english: "I never made this charge, please cancel it.",
  },
  refused: {
    hinglish: 'Mujhe interest nahi hai, please dobara call mat kijiye.',
    english: "I'm not interested, please don't call again.",
  },
  no_answer: {
    hinglish: '(Call not answered / voicemail — ring gaya par koi jawab nahi mila)',
    english: '(Call not answered / voicemail)',
  },
};

export const INTENT_LABEL_HINGLISH: Record<string, string> = {
  promise_to_pay: 'Vaada kiya hai (promise to pay)',
  funds_available_now: 'Paisa ab available hai (funds available now)',
  instrument_fixed: 'Instrument theek ho gaya (instrument fixed)',
  disputes_charge: 'Charge dispute kiya (disputes charge)',
  refused: 'Mana kar diya (refused)',
  no_answer: 'Call nahi utha (no answer)',
};

/** One decision, in three columns: what it saw, what it chose, what happened. */
export function Step({ step }: { step: TraceStep }) {
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
          {seen.assessment && (
            <div>
              <dt>Confidence</dt>
              <dd>
                <span className={`assess-badge assess-${seen.assessment.status}`}>
                  {STATUS_LABEL[seen.assessment.status] ?? seen.assessment.status}
                </span>{' '}
                · {CONFIDENCE_LABEL[seen.assessment.confidence] ?? seen.assessment.confidence}
                {seen.assessment.anomalies.length > 0 && (
                  <span className="ruletext" style={{ display: 'block', marginTop: 4 }}>
                    anomaly: {seen.assessment.anomalies.join('; ')}
                  </span>
                )}
              </dd>
            </div>
          )}
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
        {step.signal && (
          <div className="ruletext" style={{ marginTop: 8 }}>
            <p style={{ margin: 0 }}>
              <strong>Customer said:</strong> {SIGNAL_LABEL[step.signal.kind] ?? step.signal.kind}
            </p>
            <div className="voice-transcript" style={{ marginTop: 6 }}>
              <p style={{ margin: '0 0 3px', fontStyle: 'italic' }}>Simulated Hinglish voice transcript:</p>
              <p style={{ margin: '0 0 2px' }}>
                <strong>Agent:</strong> {HINGLISH_OPENING.hinglish}{' '}
                <span style={{ opacity: 0.7 }}>({HINGLISH_OPENING.english})</span>
              </p>
              <p style={{ margin: 0 }}>
                <strong>Customer:</strong>{' '}
                {(HINGLISH_CUSTOMER_LINE[step.signal.kind] ?? HINGLISH_CUSTOMER_LINE.no_answer)!.hinglish}{' '}
                <span style={{ opacity: 0.7 }}>
                  ({(HINGLISH_CUSTOMER_LINE[step.signal.kind] ?? HINGLISH_CUSTOMER_LINE.no_answer)!.english})
                </span>
              </p>
              <p style={{ margin: '4px 0 0' }}>
                <strong>Detected intent:</strong> {INTENT_LABEL_HINGLISH[step.signal.kind] ?? step.signal.kind}
              </p>
            </div>
          </div>
        )}
      </div>

      {step.candidates && step.candidates.length > 0 && (
        <div className="table-scroll" style={{ gridColumn: '1 / -1' }}>
          <table className="why-table why-table-compact">
            <thead>
              <tr>
                <th>Candidate</th>
                <th title="Amount x probability this path succeeds — not a guaranteed payout">Expected recovery</th>
                <th>Spend</th>
                <th>Annoyance</th>
                <th>Net value</th>
              </tr>
            </thead>
            <tbody>
              {[...step.candidates]
                .sort((a, b) => b.expectedValuePaise - a.expectedValuePaise)
                .map((c, i) => (
                  <tr key={i} className={c.chosen ? 'why-chosen' : c.dominated ? 'why-dominated' : undefined}>
                    <td>
                      {CANDIDATE_LABEL[c.kind] ?? c.kind}
                      {c.channel ? ` · ${c.channel}` : ''}
                      {c.chosen ? ' ←' : ''}
                    </td>
                    <td className="mono">{inr(c.grossRecoveryPaise)}</td>
                    <td className="mono">{inr(c.costPaise)}</td>
                    <td className="mono">{c.spamPoints}pt</td>
                    <td className="mono why-net">{inr(c.expectedValuePaise)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
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

  const agentTrace = current.traces.find((t) => t.strategyId === 'agent-adaptive');
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
        <p className="case-debit-note">{DEBIT_STATUS_NOTE[current.event.debitStatus] ?? DEBIT_STATUS_NOTE.no_debit}</p>
      </div>

      <h3 className="sub-h">What each strategy did with it</h3>
      <div className="race">
        {ordered.map((t) => (
          <div
            key={t.strategyId}
            className={`lane ${t.strategyId === 'agent-adaptive' ? 'lane-lead' : ''}`}
          >
            <div className="lane-head">
              <i style={{ background: strategyColor(STRATEGY_ORDER.indexOf(t.strategyId)) }} aria-hidden />
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
          <h3 className="sub-h">Every decision the adaptive agent made, and why</h3>
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
            {agentTrace.recovered ? ` — actual recovered ${inr(agentTrace.recoveredPaise)}` : ''}
          </p>
        </>
      )}
    </div>
  );
}
