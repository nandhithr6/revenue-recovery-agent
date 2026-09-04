import { useEffect, useRef, useState } from 'react';

/**
 * Replaces the old horizontal `.railnav` (buried inside the hero card,
 * scrolls out of reach the moment you leave section 01). A page this long
 * needs a nav that stays put -- fixed to the viewport, numbers only so it
 * stays out of the way of the actual content. Hidden below the width where
 * the page's own side padding can no longer fit it without overlapping
 * real content -- narrow viewports fall back to scrolling, same as any
 * other section on mobile.
 *
 * Active section is computed directly from `getBoundingClientRect()` on a
 * throttled scroll listener, not an IntersectionObserver -- a passing
 * fixed-height "reading band" is the simplest thing that is unambiguously
 * correct for a page this long (tens of thousands of px), and the direct
 * calculation is easy to verify by hand: whichever section's top edge has
 * most recently crossed the reading line is current, full stop.
 */

const SECTIONS = [
  { id: 'watch', num: '●', label: 'Live agent', hint: 'Real decision replay, not staged' },
  { id: 'voice', num: '♪', label: 'Voice (sim)', hint: 'Hinglish transcript, detected intent, honestly labelled' },
  { id: 'problem', num: '01', label: 'The problem', hint: 'Why timing changes what recovers' },
  { id: 'results', num: '02', label: 'Results', hint: 'Headline numbers, per strategy' },
  { id: 'inspect', num: '03', label: 'Inspect a case', hint: 'Pick any case, see the full reasoning' },
  { id: 'guardrails', num: '04', label: 'Guardrails', hint: 'Compliance rules that actually fired' },
  { id: 'rigor', num: '05', label: 'Is that real?', hint: '250 reruns, price sweep, adversarial tests' },
  { id: 'live', num: '06', label: 'Live Razorpay', hint: 'Real API calls, test mode' },
] as const;

/** How far from the top of the viewport the "reading line" sits. */
const READING_LINE_PX = 140;

export function SectionNav() {
  const [active, setActive] = useState<string>('watch');
  const tickingRef = useRef(false);

  useEffect(() => {
    const compute = () => {
      tickingRef.current = false;
      let current: string = SECTIONS[0]!.id;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (!el) continue;
        // The last section whose top has scrolled above the reading line
        // is the one currently being read -- walking in page order and
        // overwriting keeps this correct with no special-casing for the
        // first or last section.
        if (el.getBoundingClientRect().top <= READING_LINE_PX) current = s.id;
      }
      setActive(current);
    };

    const onScroll = () => {
      if (tickingRef.current) return;
      tickingRef.current = true;
      requestAnimationFrame(compute);
    };

    compute();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <nav className="section-nav" aria-label="Jump to a section">
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className={`section-nav-item ${active === s.id ? 'section-nav-active' : ''}`}
        >
          <span className="section-nav-num">{s.num}</span>
          <span className="section-nav-flyout">
            <span className="section-nav-label">{s.label}</span>
            <span className="section-nav-hint">{s.hint}</span>
          </span>
        </a>
      ))}
    </nav>
  );
}
