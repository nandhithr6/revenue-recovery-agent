import type { ReactNode } from 'react';

/**
 * A small, pointed callout for something on the page that IS interactive
 * but doesn't look it -- a filter that's easy to miss, a row that's
 * clickable, a section that continues well below the fold. Deliberately
 * not another paragraph of `.note` prose: a distinct visual treatment
 * (amber, icon-led, short) so it reads as "try this" rather than more
 * explanation to read past.
 */
export function Tip({ children }: { children: ReactNode }) {
  return (
    <p className="dash-tip">
      <span className="dash-tip-icon" aria-hidden="true">
        💡
      </span>
      {/* One wrapper, not raw children -- `.dash-tip` is a flex row, and
          JSX spreads a mix of text and <b> tags as separate siblings, which
          would otherwise make every bold phrase its own flex item instead
          of flowing as one paragraph of text. */}
      <span className="dash-tip-text">{children}</span>
    </p>
  );
}
