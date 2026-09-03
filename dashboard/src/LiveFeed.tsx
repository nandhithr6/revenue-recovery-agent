import { useEffect, useMemo, useRef, useState } from 'react';
import type { CandidateSummary, LiveFeedEntry } from './types';

/**
 * Watch the agent actually work.
 *
 * Every row here is real: the full, chronologically-ordered decision log the
 * engine produced for one entire cohort (typically 1,000+ entries across 500
 * cases), not a script written for the UI. Playback just reveals it at a
 * watchable pace instead of dumping it all at once.
 *
 * Layout is deliberately two-tier: one large "current decision" panel (the
 * product), one small fixed-height "activity stream" (the proof it scales).
 * Both reserve a constant footprint regardless of which entry is showing, so
 * playback never moves anything else on the page -- see the CSS comment on
 * `.decision-panel` / `.live-feed-panel` for how.
 */

const inr = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
const lakh = (paise: number): string => `₹${(paise / 10_000_000).toFixed(2)}L`;

const clock = (ms: number): string =>
  new Date(ms).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

function verb(kind: string): string {
  if (kind === 'retry_payment') return 'retry payment';
  if (kind === 'contact_customer') return 'message customer';
  if (kind === 'escalate_human') return 'escalate to human';
  if (kind === 'wait') return 'wait, then reconsider';
  return 'stop';
}

const CANDIDATE_LABEL: Record<string, string> = {
  retry_payment: 'Retry',
  contact_customer: 'Message',
  escalate_human: 'Human escalation',
  stop: 'Stop',
};

function candidateName(c: CandidateSummary): string {
  const base = CANDIDATE_LABEL[c.kind] ?? c.kind;
  return c.channel ? `${base} · ${c.channel}` : base;
}

/**
 * A compact state chip for the currently-playing decision. Deliberately
 * limited to states the ledger can actually tell apart -- one entry is one
 * already-settled outcome, not a stream of sub-states, so there is no honest
 * way to show "assessing" or "considering" per row. `REPLANNING` is the one
 * inference made beyond a single entry's own fields: it holds when the
 * previous entry for the SAME case carried a customer signal (i.e. a voice
 * call just connected and this decision is what the agent did with what it
 * heard) -- a real relationship in the sequence, not a guess.
 */
function deriveState(
  entry: LiveFeedEntry | undefined,
  prevForSameCase: LiveFeedEntry | undefined,
): { key: string; label: string } {
  if (!entry) return { key: 'waiting', label: 'WAITING' };
  if (entry.outcome === 'blocked') return { key: 'blocked', label: 'GUARDRAIL · BLOCKED' };
  if (entry.outcome === 'deferred') return { key: 'deferred', label: 'GUARDRAIL · DEFERRED' };
  if (entry.outcome === 'stopped') return { key: 'stopped', label: 'STOPPED' };
  if (entry.isRecoveryMoment) return { key: 'recovered', label: 'RECOVERED' };
  if (prevForSameCase?.signal) return { key: 'replanning', label: 'REPLANNING' };
  if (entry.succeeded === false) return { key: 'no-effect', label: 'EXECUTED · NO EFFECT' };
  return { key: 'executed', label: 'EXECUTED' };
}

function guardrailText(entry: LiveFeedEntry): string {
  if (entry.outcome === 'blocked') return `Blocked — ${entry.rule ?? 'refused'}`;
  if (entry.outcome === 'deferred') return `Deferred — ${entry.rule ?? 'held back'}, queued not dropped`;
  if (entry.outcome === 'stopped') return 'Not needed — the agent chose to stop';
  return 'Allowed to run';
}

function outcomeText(entry: LiveFeedEntry): string {
  if (entry.outcome === 'blocked') return 'Never executed';
  if (entry.outcome === 'deferred') return `Rescheduled${entry.deferredTo ? ` to ${clock(entry.deferredTo)}` : ''}`;
  if (entry.outcome === 'stopped') return 'Case closed by the agent';
  // The one place "expected recovery" (a probability-weighted estimate,
  // priced before anyone knew what would happen) turns into "actual
  // recovered" (what the ledger says really landed, for this one real
  // case) -- spelled out explicitly so it reads as a different, more
  // certain number, not a repeat of the candidate table above.
  if (entry.isRecoveryMoment) return `Actual recovered: ${inr(entry.amountPaise)} — this is the moment the money landed`;
  if (entry.succeeded === false) return 'No effect this time';
  if (entry.succeeded === true) return 'Customer engaged — next step follows';
  return 'Executed';
}

/**
 * The economic reasoning behind the currently-playing decision: every
 * candidate the agent actually priced, its believed recovery, its cost, its
 * annoyance, and the net it worked out to -- not illustrative numbers, the
 * exact ones `policies/action-registry.ts` computed for this real case (see
 * `eval/run-all.ts:candidateHook`, which calls the same `explain()`
 * function `decide()` itself is built on -- this table cannot show
 * anything other than what actually happened).
 *
 * Absent candidates (a terminal rule, a voice-signal reaction, a promise
 * window) means the decision short-circuited before anything was priced --
 * shown as the rationale alone, which is the honest answer in that case:
 * there was nothing to compare.
 */
function CurrentDecision({
  entry,
  prevForSameCase,
  totalCount,
}: {
  entry: LiveFeedEntry | undefined;
  prevForSameCase: LiveFeedEntry | undefined;
  totalCount: number;
}) {
  const state = deriveState(entry, prevForSameCase);

  if (!entry) {
    return (
      <div className="decision-panel">
        <div className="decision-head">
          <span className={`state-badge state-${state.key}`}>{state.label}</span>
          <span className="decision-case mono">—</span>
        </div>
        <div className="decision-body decision-body-idle">
          <p className="decision-idle-text">
            Press play to watch the agent price, guardrail-check, and act on the first of{' '}
            {totalCount.toLocaleString('en-IN')} real decisions.
          </p>
        </div>
        {/* Empty but present: reserves the same footprint the GUARDRAIL/OUTCOME
            rows take up once playing, so pressing play doesn't itself jump the
            panel taller. */}
        <div className="decision-foot" aria-hidden="true" />
      </div>
    );
  }

  const candidates = entry.candidates;
  const sorted = candidates ? [...candidates].sort((a, b) => b.expectedValuePaise - a.expectedValuePaise) : undefined;
  const chosen = sorted?.find((c) => c.chosen);
  const runnerUp = sorted?.find((c) => !c.chosen);
  const gap = chosen && runnerUp ? chosen.expectedValuePaise - runnerUp.expectedValuePaise : 0;

  return (
    <div className="decision-panel">
      <div className="decision-head">
        <span className={`state-badge state-${state.key}`}>{state.label}</span>
        <span className="decision-case mono">{entry.caseId}</span>
        <span className="decision-meta">
          {inr(entry.amountPaise)} · {entry.method.toUpperCase()} ·{' '}
          {entry.reasonCode ?? entry.recoveryClass}
        </span>
      </div>

      <div className="decision-body">
        {sorted && sorted.length > 0 ? (
          <>
            <div className="decision-table-wrap table-scroll">
              <table className="why-table">
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
                  {sorted.map((c, i) => (
                    <tr
                      key={i}
                      className={c.chosen ? 'why-chosen' : c.dominated ? 'why-dominated' : undefined}
                    >
                      <td>
                        {candidateName(c)}
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
            <p className="decision-table-caption">
              Expected recovery is amount × the odds that path succeeds, not a guaranteed
              payout — the full {inr(entry.amountPaise)} lands only if it actually works.
            </p>
            {chosen && (
              <p className="decision-why">
                <span className="decision-why-label">WHY THIS WON</span> {entry.rationale}
              </p>
            )}
            {chosen && runnerUp && gap > 0 && (
              <p className="decision-counterfactual">
                Next-best option: {candidateName(runnerUp)} · {inr(gap)} lower expected value
              </p>
            )}
          </>
        ) : (
          <p className="decision-shortcircuit">{entry.rationale}</p>
        )}
      </div>

      <div className="decision-foot">
        <div className="decision-foot-row">
          <span className="decision-foot-label">GUARDRAIL</span>
          <span>{guardrailText(entry)}</span>
        </div>
        <div className="decision-foot-row">
          <span className="decision-foot-label">OUTCOME</span>
          <span>{outcomeText(entry)}</span>
        </div>
      </div>
    </div>
  );
}

const SPEEDS = [
  { label: '1x', entriesPerTick: 1, tickMs: 220 },
  { label: '4x', entriesPerTick: 4, tickMs: 180 },
  { label: '15x', entriesPerTick: 15, tickMs: 140 },
  { label: '60x', entriesPerTick: 60, tickMs: 120 },
] as const;

export function LiveFeed({ entries }: { entries: readonly LiveFeedEntry[] }) {
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);
  const feedRef = useRef<HTMLDivElement>(null);

  // Restart playback from zero whenever the underlying feed changes (i.e. the
  // viewer switched scenarios) rather than continuing to play stale data.
  useEffect(() => {
    setShown(0);
    setPlaying(false);
  }, [entries]);

  useEffect(() => {
    if (!playing) return;
    const speed = SPEEDS[speedIdx]!;
    const timer = setInterval(() => {
      setShown((n) => {
        const next = Math.min(entries.length, n + speed.entriesPerTick);
        if (next >= entries.length) setPlaying(false);
        return next;
      });
    }, speed.tickMs);
    return () => clearInterval(timer);
  }, [playing, speedIdx, entries.length]);

  // Newest entries are prepended at the top of the scroll box. Follow along
  // automatically while the viewer is at (or near) the top -- but if they've
  // scrolled down to read earlier history, leave them there rather than
  // yanking the view back to the top on every new decision.
  useEffect(() => {
    const el = feedRef.current;
    if (el && el.scrollTop < 40) el.scrollTop = 0;
  }, [shown]);

  const visible = entries.slice(0, shown);
  // Every decision revealed so far, newest first -- the activity stream
  // scrolls through the WHOLE history, not just a rolling window of the
  // last few. Only the current-decision panel needs "the latest one"; nothing
  // here caps or discards older entries.
  const revealed = [...visible].reverse();
  const current = visible.at(-1);
  const prevForSameCase = current
    ? revealed.slice(1).find((e) => e.caseId === current.caseId)
    : undefined;

  const stats = useMemo(() => {
    const casesSeen = new Set<string>();
    let recoveredPaise = 0;
    let interventions = 0;
    for (const e of visible) {
      casesSeen.add(e.caseId);
      if (e.isRecoveryMoment) recoveredPaise += e.amountPaise;
      if (e.outcome === 'deferred' || e.outcome === 'blocked') interventions += 1;
    }
    return { casesSeen: casesSeen.size, recoveredPaise, interventions };
  }, [visible]);

  const done = shown >= entries.length && entries.length > 0;
  const pct = entries.length === 0 ? 0 : (shown / entries.length) * 100;

  return (
    <div className="live-feed">
      <div className="live-feed-stats">
        <div className="lf-stat">
          <span className="lf-k">Decisions played</span>
          <span className="lf-v">
            {shown.toLocaleString('en-IN')}
            <small> / {entries.length.toLocaleString('en-IN')}</small>
          </span>
        </div>
        <div className="lf-stat">
          <span className="lf-k">Cases touched</span>
          <span className="lf-v">{stats.casesSeen.toLocaleString('en-IN')}</span>
        </div>
        <div className="lf-stat">
          <span className="lf-k">Recovered so far</span>
          <span className="lf-v accent">{lakh(stats.recoveredPaise)}</span>
        </div>
        <div className="lf-stat">
          <span className="lf-k">Guardrail interventions</span>
          <span className="lf-v">{stats.interventions.toLocaleString('en-IN')}</span>
        </div>
      </div>

      <div className="live-feed-controls">
        <button
          className="lf-play"
          onClick={() => {
            if (done) setShown(0);
            setPlaying((p) => !p);
          }}
        >
          {done ? '↺ Replay' : playing ? '⏸ Pause' : shown === 0 ? '▶ Watch it work' : '▶ Resume'}
        </button>
        <div className="lf-speeds">
          {SPEEDS.map((s, i) => (
            <button
              key={s.label}
              className="lf-speed"
              aria-pressed={i === speedIdx}
              onClick={() => setSpeedIdx(i)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="lf-progress">
          <div className="lf-progress-bar" style={{ width: `${pct}%` }} />
        </div>
        {playing && <span className="lf-live-dot" aria-label="playing" />}
      </div>

      <div className="lf-main">
        <CurrentDecision entry={current} prevForSameCase={prevForSameCase} totalCount={entries.length} />

        <div className="activity-stream">
          <div className="activity-stream-head">
            <span>ACTIVITY STREAM</span>
            <span className="activity-stream-sub">
              every decision so far · {shown.toLocaleString('en-IN')} of{' '}
              {entries.length.toLocaleString('en-IN')} · scroll for earlier
            </span>
          </div>
          <div className="live-feed-panel" ref={feedRef}>
            {revealed.length === 0 && (
              <>
                <div className="lf-idle-banner">
                  ▶ press play to replay the first of {entries.length.toLocaleString('en-IN')} real
                  decisions
                </div>
                {entries.slice(0, 6).map((e) => (
                  <div key={e.seq} className="lf-row lf-preview">
                    <span className="lf-time">{clock(e.at)}</span>
                    <span className="lf-case">{e.caseId}</span>
                    <span className="lf-amt">{inr(e.amountPaise)}</span>
                    <span className="lf-action">
                      {verb(e.actionKind)}
                      {e.channel ? ` · ${e.channel}` : ''}
                    </span>
                    <span className="lf-outcome">— waiting</span>
                  </div>
                ))}
              </>
            )}
            {revealed.map((e) => (
              <div key={e.seq} className={`lf-row lf-${e.outcome}`}>
                <span className="lf-time">{clock(e.at)}</span>
                <span className="lf-case">{e.caseId}</span>
                <span className="lf-amt">{inr(e.amountPaise)}</span>
                <span className="lf-action">
                  {verb(e.actionKind)}
                  {e.channel ? ` · ${e.channel}` : ''}
                </span>
                <span className={`lf-outcome lf-${e.outcome}`}>
                  {e.outcome}
                  {e.rule ? ` (${e.rule})` : ''}
                  {e.outcome === 'executed' && e.isRecoveryMoment ? ' — recovered' : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
