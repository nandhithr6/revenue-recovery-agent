import { useEffect, useState } from 'react';

/**
 * The timing ribbon.
 *
 * This project's thesis is that *when* you act decides whether the money comes
 * back, and that compliance decides when you may speak at all. Both are
 * temporal, so the page opens with a day rather than a number.
 *
 * Deliberately monochrome. The six rows are not competing series -- they are six
 * views of one day -- and the row labels already carry identity, so colour here
 * would be decoration. Leaving it out makes the one thing that IS colour, the
 * quiet-hours band, the only chromatic event on the ribbon.
 */

const HOURS = 24;
const QUIET_START = 21;
const QUIET_END = 9;

export interface ClassTrack {
  readonly label: string;
  readonly offsetsHours: readonly number[];
  readonly note: string;
}

export function TimingRibbon({
  tracks,
  animate = true,
}: {
  tracks: readonly ClassTrack[];
  animate?: boolean;
}) {
  const [revealed, setRevealed] = useState(animate ? 0 : tracks.length);

  useEffect(() => {
    if (!animate) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRevealed(tracks.length);
      return;
    }
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      setRevealed(i);
      if (i >= tracks.length) clearInterval(timer);
    }, 170);
    return () => clearInterval(timer);
  }, [animate, tracks.length]);

  // Three columns: labels, the day itself, and a notes gutter. The notes live
  // in their own column so they can never collide with a mark.
  const width = 1020;
  const labelW = 186;
  const noteW = 268;
  const plotL = labelW + 16;
  const plotR = width - noteW;
  const plot = plotR - plotL;

  const rowH = 38;
  const top = 40;
  const height = top + tracks.length * rowH + 30;

  const x = (h: number) => plotL + (Math.min(Math.max(h, 0), HOURS) / HOURS) * plot;
  const bandTop = 22;
  const bandBottom = height - 26;

  return (
    <div className="chart ribbon-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Retry timing per failure class across a 24-hour day, with quiet hours marked"
      >
        {/* Quiet hours. Two bands, because the window wraps midnight. */}
        <rect x={plotL} y={bandTop} width={x(QUIET_END) - plotL} height={bandBottom - bandTop} fill="var(--night)" />
        <rect
          x={x(QUIET_START)}
          y={bandTop}
          width={plotR - x(QUIET_START)}
          height={bandBottom - bandTop}
          fill="var(--night)"
        />
        <line x1={x(QUIET_END)} y1={bandTop} x2={x(QUIET_END)} y2={bandBottom} stroke="var(--rule-strong)" strokeWidth={1} />
        <line x1={x(QUIET_START)} y1={bandTop} x2={x(QUIET_START)} y2={bandBottom} stroke="var(--rule-strong)" strokeWidth={1} />

        {/* Hour ruling every three hours. */}
        {Array.from({ length: HOURS / 3 + 1 }, (_, i) => i * 3).map((h) => (
          <g key={h}>
            <line x1={x(h)} y1={bandTop} x2={x(h)} y2={bandBottom} stroke="var(--rule)" strokeWidth={1} />
            <text x={x(h)} y={14} textAnchor="middle" className="tick">
              {String(h).padStart(2, '0')}
            </text>
          </g>
        ))}

        <text x={x(QUIET_END) - 10} y={height - 10} textAnchor="end" className="tick">
          quiet
        </text>
        <text x={x(QUIET_START) + 10} y={height - 10} className="tick">
          quiet
        </text>
        <text x={x(12)} y={height - 10} textAnchor="middle" className="tick">
          hours after the payment failed
        </text>

        {tracks.map((track, ti) => {
          const y = top + ti * rowH;
          const shown = ti < revealed;
          const marks = track.offsetsHours.filter((h) => h <= HOURS);
          const overflow = track.offsetsHours.filter((h) => h > HOURS).length;
          const end = marks.length ? x(Math.max(...marks)) : plotL;

          return (
            <g key={track.label} opacity={shown ? 1 : 0} style={{ transition: 'opacity .4s ease' }}>
              <text x={labelW} y={y + 4} textAnchor="end" className="row-label">
                {track.label}
              </text>

              {marks.length > 0 && (
                <line x1={plotL} y1={y} x2={end} y2={y} stroke="var(--ink-3)" strokeWidth={2} opacity={0.5} />
              )}

              {marks.map((h, i) => (
                <g key={i}>
                  <circle cx={x(h)} cy={y} r={5} fill="var(--ink)" stroke="var(--paper)" strokeWidth={2} />
                  <title>{`${track.label}: retry ${i + 1} at +${h.toFixed(1)}h`}</title>
                </g>
              ))}

              {marks.length === 0 && (
                <line
                  x1={plotL}
                  y1={y}
                  x2={plotR}
                  y2={y}
                  stroke="var(--rule-strong)"
                  strokeWidth={1}
                  strokeDasharray="2 5"
                />
              )}

              <text x={plotR + 22} y={y + 4} className="ribbon-note">
                {overflow > 0 ? `${track.note} · +${overflow} beyond` : track.note}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
