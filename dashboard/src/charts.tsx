import { useId, useState } from 'react';

/**
 * Charts, in plain SVG.
 *
 * Conventions applied throughout, per the visualisation method:
 *  - thin marks, 4px rounded data-ends anchored to the baseline
 *  - a 2px surface gap between adjacent fills so bars never touch
 *  - every mark carries a visible direct label, which is also what makes the
 *    light-mode contrast warning on the aqua and yellow slots safe: identity is
 *    never carried by colour alone
 *  - recessive grid and axis, ink-token text, one axis only
 */

export const SERIES_VARS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
] as const;

export function seriesColor(index: number): string {
  // Fixed order, never cycled: colour follows the entity, not its rank.
  return SERIES_VARS[index] ?? 'var(--ink-3)';
}

/**
 * Colour for one of the five strategies, by their canonical array position
 * (do-nothing, naive-retry, fixed-dunning, agent-adaptive, agent-rules).
 * `do-nothing` recovers nothing in every scenario -- it has no bar worth
 * distinguishing -- so it gets a neutral grey rather than eating one of the
 * four validated, colourblind-checked categorical slots meant to tell the
 * four REAL strategies apart. (Plain `seriesColor` stays as-is: other charts
 * pass an explicit, unrelated `colorIndex` through it, e.g. the guardrail
 * rule tally, and must not shift when this offsets.)
 */
export function strategyColor(index: number): string {
  if (index === 0) return 'var(--ink-3)';
  return SERIES_VARS[index - 1] ?? 'var(--ink-3)';
}

export interface BarRow {
  readonly label: string;
  readonly value: number;
  readonly display: string;
  readonly colorIndex: number;
  readonly tooltip?: string;
}

/**
 * Horizontal bars. The right form when category labels are words rather than
 * dates, and when there are few enough categories to label each one directly.
 */
export function HorizontalBars({
  rows,
  height = 34,
  labelWidth = 148,
}: {
  rows: readonly BarRow[];
  height?: number;
  labelWidth?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useId();

  const width = 640;
  const valueGutter = 108;
  const plotWidth = width - labelWidth - valueGutter;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const chartHeight = rows.length * height + 8;
  const barHeight = 16;

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${width} ${chartHeight}`}
        width="100%"
        height={chartHeight}
        role="img"
        aria-label="Horizontal bar chart"
      >
        <defs>
          <clipPath id={clipId}>
            <rect x="0" y="0" width={width} height={chartHeight} />
          </clipPath>
        </defs>

        {/* Baseline. Recessive by design - the marks carry the meaning. */}
        <line
          x1={labelWidth}
          y1={4}
          x2={labelWidth}
          y2={chartHeight - 4}
          stroke="var(--axis)"
          strokeWidth={1}
        />

        {rows.map((row, i) => {
          const y = i * height + 8;
          const w = Math.max((row.value / max) * plotWidth, row.value > 0 ? 3 : 0);
          return (
            <g
              key={row.label}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              clipPath={`url(#${clipId})`}
            >
              {/* Oversized hit target, bigger than the mark itself. */}
              <rect x={0} y={y - 6} width={width} height={height - 2} fill="transparent" />
              <text x={labelWidth - 10} y={y + barHeight - 3} textAnchor="end" className="row-label">
                {row.label}
              </text>
              <rect
                className="bar"
                x={labelWidth + 1}
                y={y}
                width={w}
                height={barHeight}
                rx={4}
                fill={seriesColor(row.colorIndex)}
                opacity={hover === null || hover === i ? 1 : 0.45}
              />
              <text x={labelWidth + w + 10} y={y + barHeight - 3} className="mark-label">
                {row.display}
              </text>
              {hover === i && row.tooltip && (
                <title>{row.tooltip}</title>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && rows[hover]?.tooltip && (
        <p style={{ color: 'var(--ink-2)', fontSize: 13, margin: '6px 0 0' }}>
          {rows[hover]!.tooltip}
        </p>
      )}
    </div>
  );
}

export interface GroupedRow {
  readonly group: string;
  readonly values: readonly { readonly label: string; readonly value: number; readonly display: string }[];
}

/**
 * Grouped bars: one cluster per recovery class, one bar per strategy.
 *
 * This is the chart that carries the argument -- it shows each baseline winning
 * a different class and losing another, which is the whole case for being
 * reason-aware.
 */
export function GroupedBars({
  rows,
  maxValue = 1,
  formatTick = (v: number) => `${Math.round(v * 100)}%`,
}: {
  rows: readonly GroupedRow[];
  maxValue?: number;
  formatTick?: (v: number) => string;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const width = 680;
  const labelWidth = 190;
  const rowHeight = 74;
  const barHeight = 11;
  const gap = 2; // 2px surface gap between adjacent fills
  const plotWidth = width - labelWidth - 60;
  const chartHeight = rows.length * rowHeight + 26;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * maxValue);

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${width} ${chartHeight}`} width="100%" height={chartHeight} role="img">
        {ticks.map((t) => {
          const x = labelWidth + (t / maxValue) * plotWidth;
          return (
            <g key={t}>
              <line
                x1={x}
                y1={16}
                x2={x}
                y2={chartHeight - 8}
                stroke="var(--grid)"
                strokeWidth={1}
              />
              <text x={x} y={11} textAnchor="middle" className="tick">
                {formatTick(t)}
              </text>
            </g>
          );
        })}

        {rows.map((row, ri) => {
          const top = ri * rowHeight + 24;
          return (
            <g key={row.group}>
              <text x={labelWidth - 12} y={top + 22} textAnchor="end" className="row-label">
                {row.group}
              </text>
              {row.values.map((v, vi) => {
                const y = top + vi * (barHeight + gap);
                const w = Math.max((v.value / maxValue) * plotWidth, v.value > 0 ? 2 : 0);
                const key = `${row.group}-${v.label}`;
                // `do-nothing` (vi === 0) scores exactly 0% on every class in
                // every scenario, by construction -- its "0.0%" is the same
                // uninformative label repeated on every single row, so it's
                // skipped. A REAL strategy scoring 0% on a class is different:
                // that's a genuine finding (this approach completely whiffs
                // here), and hiding it made rows look like data was missing
                // rather than measured-and-zero -- so those stay.
                if (vi === 0 && v.value <= 0) return null;
                return (
                  <g
                    key={key}
                    onMouseEnter={() => setHover(key)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <rect
                      x={labelWidth}
                      y={y - 1}
                      width={width - labelWidth}
                      height={barHeight + gap}
                      fill="transparent"
                    />
                    <rect
                      className="bar"
                      x={labelWidth}
                      y={y}
                      width={w}
                      height={barHeight}
                      rx={3.5}
                      fill={strategyColor(vi)}
                      opacity={hover === null || hover === key ? 1 : 0.4}
                    />
                    <text x={labelWidth + w + 7} y={y + barHeight - 1.5} className="mark-label" fontSize={11}>
                      {v.display}
                    </text>
                    <title>{`${v.label} - ${row.group}: ${v.display}`}</title>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Legend. Always present for two or more series. */
export function Legend({ items }: { items: readonly string[] }) {
  return (
    <div className="legend">
      {items.map((label, i) => (
        <span key={label}>
          <i className="swatch" style={{ background: strategyColor(i) }} aria-hidden />
          {label}
        </span>
      ))}
    </div>
  );
}
