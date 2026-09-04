import { useState } from 'react';
import {
  HINGLISH_CUSTOMER_LINE,
  HINGLISH_OPENING,
  INTENT_LABEL_HINGLISH,
  SIGNAL_LABEL,
  Step,
} from './CaseInspector';
import type { VoiceShowcase as VoiceShowcaseData } from './types';

/**
 * Part L of the design review: one featured case demonstrating the full
 * unknown/known -> reasoning -> voice -> structured response -> replanning
 * -> outcome chain. Open by default -- this is one of the clearest proofs
 * the agent reasons rather than scripts a channel, so it should be visible
 * without a click, not buried behind progressive disclosure.
 *
 * Every step here is `Step` from `CaseInspector.tsx` -- the same component
 * the ordinary case inspector uses, reading the same trace shape. There is
 * no separate rendering path that could show something the engine didn't
 * actually produce. The featured case itself is found by
 * `eval/run-all.ts:findVoiceShowcase` fresh on every `eval:all` run, so the
 * description below stays generic rather than asserting specifics that
 * might not match whichever real case was found this time.
 *
 * The "call summary" card up top is a product-shaped READING of the exact
 * same `signal` the full step trace below already carries -- same
 * dictionaries `CaseInspector.tsx:Step` uses for its own "Customer said"
 * line, imported rather than duplicated, so the two can never drift apart.
 * It exists because a technical step-by-step trace and "here's what the
 * call actually sounded like" are different readerships, and a voice
 * feature should be legible to the second one without losing the first.
 */
const inr = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

export function VoiceShowcase({ data }: { data: VoiceShowcaseData | null }) {
  // Collapsed by default: the call-summary card below is always visible
  // (a compact, glanceable "nice case") -- this toggle is only for the
  // full technical step-by-step audit trail underneath it.
  const [open, setOpen] = useState(false);
  if (!data) return null;

  // The FIRST time voice was decided -- highlighted below, even if it was
  // deferred (e.g. CONTACT_COOLDOWN) rather than landing immediately; that
  // deferral is itself real and part of the story.
  const voiceStepIndex = data.trace.steps.findIndex(
    (s) => s.decided.kind === 'contact_customer' && s.decided.channel === 'voice',
  );
  const voiceStep = voiceStepIndex >= 0 ? data.trace.steps[voiceStepIndex] : undefined;
  const voiceCandidates = voiceStep?.candidates;
  const chosenVoice = voiceCandidates?.find((c) => c.chosen);
  const runnerUp = voiceCandidates?.find((c) => !c.chosen);
  const margin = chosenVoice && runnerUp ? chosenVoice.expectedValuePaise - runnerUp.expectedValuePaise : undefined;

  // The call summary needs the voice attempt that actually EXECUTED and
  // produced a signal -- not necessarily the first one decided, since a
  // guardrail can defer an earlier attempt (see `voiceStepIndex` above).
  // `signal` is only ever set on an executed contact_customer step, so
  // this always lands on the real, landed call, wherever it is in the
  // trace.
  const landedVoiceStepIndex = data.trace.steps.findIndex(
    (s) => s.decided.kind === 'contact_customer' && s.decided.channel === 'voice' && s.signal,
  );
  const landedVoiceStep = landedVoiceStepIndex >= 0 ? data.trace.steps[landedVoiceStepIndex] : undefined;
  const signal = landedVoiceStep?.signal;
  const resultingStep = landedVoiceStepIndex >= 0 ? data.trace.steps[landedVoiceStepIndex + 1] : undefined;

  // `receivable` and `checkout_abandonment` have no underlying charge to
  // retry -- the customer acting on the nudge IS the payment (see
  // `sim/recovery-model.ts:recoversViaLink`), so a positive voice signal can
  // close the case in the SAME step, with no separate "retry" row after it.
  const recoversViaLink = data.event.lossType === 'receivable' || data.event.lossType === 'checkout_abandonment';

  return (
    <div className="showcase-card" id="voice">
      <div className="showcase-head">
        <span className="showcase-badge">{data.source === 'naturally-occurring' ? 'Real case' : 'Constructed fixture'}</span>
        <span className="showcase-badge showcase-badge-sim">◐ SIMULATED VOICE</span>
        <span className="showcase-title">
          {data.event.id} · {inr(data.event.amountPaise)} ·{' '}
          {data.trace.recovered ? 'recovered' : 'not recovered'}
        </span>
      </div>

      {signal && (
        <div className="call-summary">
          <div className="call-summary-transcript">
            <div className="call-bubble call-bubble-agent">
              <span className="call-bubble-role">Agent</span>
              <p>{HINGLISH_OPENING.hinglish}</p>
              <p className="call-bubble-en">{HINGLISH_OPENING.english}</p>
            </div>
            <div className="call-bubble call-bubble-customer">
              <span className="call-bubble-role">Customer</span>
              <p>{(HINGLISH_CUSTOMER_LINE[signal.kind] ?? HINGLISH_CUSTOMER_LINE.no_answer)!.hinglish}</p>
              <p className="call-bubble-en">
                {(HINGLISH_CUSTOMER_LINE[signal.kind] ?? HINGLISH_CUSTOMER_LINE.no_answer)!.english}
              </p>
            </div>
          </div>
          <div className="call-summary-meta">
            <div className="call-summary-row">
              <span className="call-summary-k">Detected intent</span>
              <span className="call-summary-v">{INTENT_LABEL_HINGLISH[signal.kind] ?? signal.kind}</span>
            </div>
            <div className="call-summary-row">
              <span className="call-summary-k">Structured signal</span>
              <span className="call-summary-v mono">{signal.kind}</span>
            </div>
            <div className="call-summary-row">
              <span className="call-summary-k">Resulting action</span>
              <span className="call-summary-v">
                {resultingStep
                  ? resultingStep.decided.kind.replace(/_/g, ' ')
                  : SIGNAL_LABEL[signal.kind]?.split(' — ')[1] ?? 'case closed'}
              </span>
            </div>
          </div>
        </div>
      )}

      <button className="showcase-toggle showcase-toggle-inline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? '− Hide' : '+ Show'} the full audit trail (every step, guardrail, and priced candidate)
      </button>

      {open && (
        <div className="showcase-body">
          <p className="note" style={{ marginLeft: 0 }}>
            {data.source === 'naturally-occurring'
              ? 'A real case from this cohort — found by searching the actual run for one where a voice call changed what the agent did next, not scripted for this page.'
              : 'A constructed fixture: still the real engine and guardrails, built so this exact sequence was likely rather than rare.'}{' '}
            {margin !== undefined && margin > 0
              ? `Voice cleared the bar by ${inr(margin)} of expected value over the next-best channel — watch the highlighted row below.`
              : 'Watch the highlighted row for why voice cleared the bar here.'}{' '}
            The bilingual transcript above and "Customer said" below are both generated from the
            case's structured outcome for readability — every field reads off the SAME signal the
            trace below prices and reacts to. The engine itself only ever sees the structured
            signal (<code>promise_to_pay</code>, <code>refused</code>, …), never a sentence in any
            language, and neither transcript can change what the agent decides.
          </p>
          {data.trace.recovered && recoversViaLink && (
            <p className="note" style={{ marginLeft: 0, marginTop: 8 }}>
              <strong>Why there's no separate "retry" step:</strong> this loss type (
              <code>{data.event.lossType}</code>) has no underlying charge to re-attempt — the
              customer acting on the nudge <em>is</em> the payment. So a positive voice signal
              can close the case in that same step, with the recovered amount landing right
              there rather than after a follow-up retry.
            </p>
          )}

          <div className="steps" style={{ marginTop: 14 }}>
            {data.trace.steps.map((s, i) => (
              <div key={s.step} className={i === voiceStepIndex ? 'showcase-voice-step' : undefined}>
                <Step step={s} defaultOpen />
              </div>
            ))}
          </div>
          <p className="closing mono">
            Closed: {data.trace.stoppedReason}
            {data.trace.recovered ? ` — actual recovered ${inr(data.trace.recoveredPaise)}` : ''}
          </p>
        </div>
      )}
    </div>
  );
}
