import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveFeedEntry } from './types';

/**
 * Watch the agent actually work.
 *
 * Every row here is real: the full, chronologically-ordered decision log the
 * engine produced for one entire cohort (typically 1,000+ entries across 500
 * cases), not a script written for the UI. Playback just reveals it at a
 * watchable pace instead of dumping it all at once.
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
  return 'stop';
}

const SPEEDS = [
  { label: '1x', entriesPerTick: 1, tickMs: 220 },
  { label: '4x', entriesPerTick: 4, tickMs: 180 },
  { label: '15x', entriesPerTick: 15, tickMs: 140 },
  { label: '60x', entriesPerTick: 60, tickMs: 120 },
] as const;

const VISIBLE_ROWS = 28;

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

  const visible = entries.slice(0, shown);
  const window_ = visible.slice(-VISIBLE_ROWS).reverse();

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

      <div className={`live-feed-panel ${window_.length === 0 ? 'lf-idle' : ''}`} ref={feedRef}>
        {window_.length === 0 && (
          <>
            <div className="lf-idle-banner">
              ▶ press play to replay the first of {entries.length.toLocaleString('en-IN')} real
              decisions
            </div>
            {entries.slice(0, 8).map((e) => (
              <div key={e.seq} className="lf-row lf-preview">
                <span className="lf-time">{clock(e.at)}</span>
                <span className="lf-case">{e.caseId}</span>
                <span className="lf-amt">{inr(e.amountPaise)}</span>
                <span className="lf-reason">{e.reasonCode ?? e.recoveryClass}</span>
                <span className="lf-action">
                  {verb(e.actionKind)}
                  {e.channel ? ` · ${e.channel}` : ''}
                </span>
                <span className="lf-outcome">— waiting</span>
              </div>
            ))}
          </>
        )}
        {window_.map((e) => (
          <div key={e.seq} className={`lf-row lf-${e.outcome}`}>
            <span className="lf-time">{clock(e.at)}</span>
            <span className="lf-case">{e.caseId}</span>
            <span className="lf-amt">{inr(e.amountPaise)}</span>
            <span className="lf-reason">{e.reasonCode ?? e.recoveryClass}</span>
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
  );
}
