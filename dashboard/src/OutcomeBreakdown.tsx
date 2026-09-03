import { Fragment, useState } from 'react';
import { HorizontalBars, type BarRow } from './charts';
import type { OutcomeAudit } from './types';

/**
 * Answers "is 59.8% a failure rate?" directly, instead of leaving a reader to
 * assume it. Most of a cohort's non-recovered cases were never realistically
 * getable (a hard decline, a customer who never fixed their card) or were
 * correctly stopped once the real odds went to zero -- this breaks the
 * denominator down so "recovered" isn't read against "everything else",
 * it's read against the much smaller slice that was actually missed.
 */

const inr = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

// Fixed order + colour so a category always reads the same way across
// scenarios: green-leaning for "system worked as intended", amber for the
// two genuine judgement calls, red only for the one bucket that names a real
// mistake.
const CATEGORY_COLOR: Record<string, number> = {
  hard_permanent_failure: 3,
  customer_never_acted: 3,
  genuinely_unrecoverable: 3,
  uncertain_verification_unsafe: 2,
  correctly_stopped_non_positive_ev: 0,
  correctly_waited_bad_luck: 1,
  wrong_action_missed_opportunity: 3,
  simulator_model_limitation: 2,
};

const CATEGORY_SHORT: Record<string, string> = {
  genuinely_unrecoverable: 'No path existed',
  customer_never_acted: 'Customer never acted',
  hard_permanent_failure: 'Hard decline',
  uncertain_verification_unsafe: 'Unsafe to push (dispute/verification)',
  correctly_stopped_non_positive_ev: 'Correctly stopped',
  correctly_waited_bad_luck: 'Tried, lost the odds',
  wrong_action_missed_opportunity: 'Agent picked worse than it should have',
  simulator_model_limitation: 'Taxonomy/data gap',
};

export function OutcomeBreakdown({ audit }: { audit: OutcomeAudit }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const nonZero = audit.categories.filter((c) => c.count > 0);
  const rows: BarRow[] = nonZero.map((c) => ({
    label: CATEGORY_SHORT[c.category] ?? c.category,
    value: c.count,
    display: `${c.count} (${inr(c.atRiskPaise)})`,
    colorIndex: CATEGORY_COLOR[c.category] ?? 0,
    tooltip: c.label,
  }));

  const genuineMisses = audit.categories.find((c) => c.category === 'wrong_action_missed_opportunity');

  return (
    <div className="outcome-audit">
      <div className="headline" style={{ marginBottom: 14 }}>
        <span className="big">
          {pct(audit.recoveryRate)}
          <span className="of"> recovered</span>
        </span>
        <p>
          of {audit.totalCases} cases ({inr(audit.recoveredCases === audit.totalCases ? 0 : audit.nonRecoveredAtRiskPaise)}{' '}
          of the {inr(audit.nonRecoveredAtRiskPaise)} left on the table breaks down below). Recovery rate is not a
          success rate for the agent's decisions -- most of what's left was never realistically getable, or was
          correctly declined once the real odds went to zero. <strong>{genuineMisses?.count ?? 0}</strong> case
          {genuineMisses?.count === 1 ? '' : 's'} out of {audit.totalCases} show a genuine missed opportunity.
        </p>
      </div>

      <HorizontalBars rows={rows} labelWidth={220} />

      <div className="table-scroll" style={{ marginTop: 16 }}>
        <table className="ledger">
          <thead>
            <tr>
              <th>Outcome</th>
              <th>Cases</th>
              <th>₹ at risk</th>
              <th>By class</th>
            </tr>
          </thead>
          <tbody>
            {audit.categories.map((c) => (
              <Fragment key={c.category}>
                <tr
                  className={c.category === 'wrong_action_missed_opportunity' && c.count > 0 ? 'lead' : undefined}
                  onClick={() => setExpanded(expanded === c.category ? null : c.category)}
                  style={{ cursor: c.examples.length > 0 ? 'pointer' : undefined }}
                >
                  <td>{c.label}</td>
                  <td className="money">{c.count}</td>
                  <td className="money">{c.count > 0 ? inr(c.atRiskPaise) : '--'}</td>
                  <td>
                    {Object.entries(c.byClass)
                      .sort((a, b) => b[1] - a[1])
                      .map(([k, n]) => `${k}: ${n}`)
                      .join(', ') || '--'}
                  </td>
                </tr>
                {expanded === c.category && c.examples.length > 0 && (
                  <tr>
                    <td colSpan={4} style={{ background: 'var(--panel-2, transparent)' }}>
                      <ul style={{ margin: '8px 0', paddingLeft: 18, fontSize: 13 }}>
                        {c.examples.map((ex) => (
                          <li key={ex.eventId} style={{ marginBottom: 6 }}>
                            <code>{ex.eventId}</code> ({inr(ex.amountPaise)}, {ex.recoveryClass}) --{' '}
                            {ex.note}
                            {ex.missedAction && (
                              <>
                                {' '}
                                <strong>
                                  Alternative: {ex.missedAction}, real EV ~{inr(ex.missedRealEvPaise ?? 0)}.
                                </strong>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
