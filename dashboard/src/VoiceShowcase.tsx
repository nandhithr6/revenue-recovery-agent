import { useState } from 'react';
import { Step } from './CaseInspector';
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
 */
const inr = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

export function VoiceShowcase({ data }: { data: VoiceShowcaseData | null }) {
  const [open, setOpen] = useState(true);
  if (!data) return null;

  const voiceStepIndex = data.trace.steps.findIndex(
    (s) => s.decided.kind === 'contact_customer' && s.decided.channel === 'voice',
  );
  const voiceStep = voiceStepIndex >= 0 ? data.trace.steps[voiceStepIndex] : undefined;
  const voiceCandidates = voiceStep?.candidates;
  const chosenVoice = voiceCandidates?.find((c) => c.chosen);
  const runnerUp = voiceCandidates?.find((c) => !c.chosen);
  const margin = chosenVoice && runnerUp ? chosenVoice.expectedValuePaise - runnerUp.expectedValuePaise : undefined;

  // `receivable` and `checkout_abandonment` have no underlying charge to
  // retry -- the customer acting on the nudge IS the payment (see
  // `sim/recovery-model.ts:recoversViaLink`), so a positive voice signal can
  // close the case in the SAME step, with no separate "retry" row after it.
  // Worth saying explicitly: without it, a recovery that appears one step
  // after "customer said X" with no visible retry in between reads as a gap
  // in the trace rather than what it is -- a different loss type's own
  // recovery mechanic.
  const recoversViaLink = data.event.lossType === 'receivable' || data.event.lossType === 'checkout_abandonment';

  return (
    <div className="showcase-card">
      <button className="showcase-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="showcase-badge">{data.source === 'naturally-occurring' ? 'Real case' : 'Constructed fixture'}</span>
        <span className="showcase-badge showcase-badge-sim">Simulated voice</span>
        <span className="showcase-title">
          VOICE → REPLAN · {data.event.id} · {inr(data.event.amountPaise)} ·{' '}
          {data.trace.recovered ? 'recovered' : 'not recovered'}
        </span>
        <span className="showcase-chevron">{open ? '−' : '+'}</span>
      </button>
      {!open && (
        <p className="showcase-collapsed-line">
          {margin !== undefined && margin > 0
            ? `Voice chosen — ${inr(margin)} higher expected value than the next-best channel.`
            : 'Voice chosen because its incremental recovery value justified its higher customer cost.'}
        </p>
      )}

      {open && (
        <div className="showcase-body">
          <p className="note" style={{ marginLeft: 0 }}>
            {data.source === 'naturally-occurring'
              ? 'A real case from this cohort — found by searching the actual run for one where a voice call changed what the agent did next, not scripted for this page.'
              : 'A constructed fixture: still the real engine and guardrails, built so this exact sequence was likely rather than rare.'}{' '}
            {margin !== undefined && margin > 0
              ? `Voice cleared the bar by ${inr(margin)} of expected value over the next-best channel — watch the highlighted row below.`
              : 'Watch the highlighted row for why voice cleared the bar here.'}{' '}
            "Customer said" is generated from the case's structured outcome for readability — the
            engine itself only ever sees the structured signal (<code>promise_to_pay</code>,{' '}
            <code>refused</code>, …), never a sentence.
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
          <div className="steps">
            {data.trace.steps.map((s, i) => (
              <div key={s.step} className={i === voiceStepIndex ? 'showcase-voice-step' : undefined}>
                <Step step={s} />
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
