import { seriesColor } from './charts';
import type { LiveDecline, LiveRun, Robustness, Sensitivity } from './types';

/**
 * The three sections that answer "how do you know?" rather than "what happened?"
 *
 * Robustness answers "did you get lucky once?". Sensitivity answers "does your
 * answer depend on a constant you chose?". The live section answers "does any of
 * this touch a real payment system?".
 *
 * All three read from files produced by separate commands. When a command has
 * not been run, the section says so plainly instead of vanishing — a missing
 * proof should be visible, not silently absent.
 */

const lakh = (paise: number): string => `₹${(paise / 10_000_000).toFixed(2)}L`;
const rupees = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

const STRATEGY_ORDER = ['do-nothing', 'naive-retry', 'fixed-dunning', 'agent-rules'];

function NotRun({ cmd }: { cmd: string }) {
  return (
    <p className="note" style={{ marginLeft: 0 }}>
      Not run yet. Produce it with <code>{cmd}</code>, then re-run{' '}
      <code>npm run eval:all</code>.
    </p>
  );
}

export function RobustnessSection({ data }: { data: Robustness | null }) {
  if (!data) return <NotRun cmd="npm run eval:robust" />;

  const pct = ((data.agentWins / data.totalRuns) * 100).toFixed(1);

  return (
    <>
      <div className="headline">
        <span className="big">
          {data.agentWins}<span className="of">/{data.totalRuns}</span>
        </span>
        <p>
          independent cohorts where the reason-aware agent posted the highest net value —{' '}
          <strong>{pct}%</strong>. {data.scenarios.length} scenarios × {data.seeds} seeds ×{' '}
          {data.cohortSize} cases, every cohort and every engine roll independently reseeded.
        </p>
      </div>

      <table className="ledger">
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Agent mean</th>
            <th>p10</th>
            <th>p90</th>
            <th>Std dev</th>
            <th>Best baseline mean</th>
            <th>Agent wins</th>
          </tr>
        </thead>
        <tbody>
          {data.scenarios.map((s) => {
            const agent = s.strategies.find((x) => x.strategyId === 'agent-rules');
            const best = s.strategies
              .filter((x) => x.strategyId !== 'agent-rules')
              .reduce((a, b) => (b.netValue.mean > a.netValue.mean ? b : a));
            if (!agent) return null;
            const perfect = agent.wins === agent.runs;
            return (
              <tr key={s.scenarioId}>
                <td>{s.scenarioName}</td>
                <td className="money">{lakh(agent.netValue.mean)}</td>
                <td className="money">{lakh(agent.netValue.p10)}</td>
                <td className="money">{lakh(agent.netValue.p90)}</td>
                <td className="money">±{lakh(agent.netValue.stdDev)}</td>
                <td className="money">{lakh(best.netValue.mean)}</td>
                <td className="money">
                  <span className={perfect ? 'zero' : undefined}>
                    {agent.wins}/{agent.runs}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="note" style={{ marginLeft: 0, marginTop: 18 }}>
        It is not {data.totalRuns} of {data.totalRuns}, and the losses are left in rather than
        tuned away. A strategy adjusted until it wins every run is a strategy overfitted to the
        runs you happened to write. Compliance violations across every strategy and every one of
        these runs: <strong>{data.totalViolations}</strong>.
      </p>
    </>
  );
}

export function SensitivitySection({ data }: { data: Sensitivity | null }) {
  if (!data) return <NotRun cmd="npm run eval:sensitivity" />;

  const first = data.scenarios[0];
  if (!first) return <NotRun cmd="npm run eval:sensitivity" />;

  return (
    <>
      <p className="note" style={{ marginLeft: 0 }}>
        Our headline metric prices customer annoyance at{' '}
        <strong>{rupees(data.shippedPricePaise)}</strong> a point. That is a judgement call and
        the most attackable number here, so rather than defend it we sweep it — rebuilding the
        agent at each price so it knows what annoyance costs, and averaging {data.seeds} seeds a
        point.
      </p>

      <table className="ledger">
        <thead>
          <tr>
            <th>Scenario</th>
            {first.adaptive.points.map((p) => (
              <th key={p.pricePaise}>{rupees(p.pricePaise)}</th>
            ))}
            <th>Winner changes?</th>
          </tr>
        </thead>
        <tbody>
          {data.scenarios.map((s) => (
            <tr key={s.scenarioId}>
              <td>{s.scenarioName}</td>
              {s.adaptive.points.map((p) => (
                <td key={p.pricePaise} className="money">
                  {lakh(p.byStrategy['agent-rules'] ?? 0)}
                </td>
              ))}
              <td className="money">
                <span className={s.adaptive.flipped ? undefined : 'zero'}>
                  {s.adaptive.flipped ? 'yes' : 'no'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="note" style={{ marginLeft: 0, marginTop: 18 }}>
        {data.adaptiveRankingStable ? (
          <>
            Told what annoyance costs, the agent posts the highest net value at{' '}
            <strong>every price from {rupees(data.pricesPaise[0] ?? 0)} to{' '}
            {rupees(data.pricesPaise.at(-1) ?? 0)}</strong>, in all {data.scenarios.length}{' '}
            scenarios. The constant is an input, not a thumb on the scale.
          </>
        ) : (
          <>The winner does change with the price in some scenarios — see the engineering log.</>
        )}
      </p>
    </>
  );
}

export function LiveSection({
  run,
  decline,
}: {
  run: LiveRun | null;
  decline: LiveDecline | null;
}) {
  if (!run && !decline) return <NotRun cmd="npm run live" />;

  return (
    <>
      {decline && (
        <>
          <h3 className="sub-h" style={{ marginTop: 0 }}>
            A genuine decline, straight from the API
          </h3>
          <p className="note" style={{ marginLeft: 0 }}>
            A real payment link, paid at Razorpay's hosted checkout with one of their failure test
            cards, then read back through the API. Every field below is Razorpay-authored —
            nothing here was written by us.
          </p>

          <div className="evidence-grid">
            <div className="panel">
              <h4>What Razorpay returned</h4>
              <dl>
                {Object.entries(decline.razorpayError).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd className="mono">{v ?? '—'}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="panel">
              <h4>Did our taxonomy know it?</h4>
              <p className="decision">
                {decline.taxonomyRecognised ? 'Yes' : 'No — a finding, not a failure'}
              </p>
              {decline.recoveryClass && (
                <p className="ruletext">
                  <code>{decline.razorpayError['error_reason']}</code> maps to{' '}
                  <strong>{decline.recoveryClass}</strong>
                </p>
              )}
              <p className="ruletext" style={{ marginTop: 10 }}>
                The taxonomy was built from Razorpay's published error docs. This checks it
                against what the API actually emits, which is not always the same thing.
              </p>
            </div>

            <div className="panel">
              <h4>What the agent did with it</h4>
              {decline.agentDecisions.map((d) => (
                <div key={d.step} style={{ marginBottom: 10 }}>
                  <p className="decision">{d.kind.replace(/_/g, ' ')}</p>
                  <blockquote>{d.rationale}</blockquote>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {run && (
        <>
          <h3 className="sub-h">Recovery actions as real API calls</h3>
          <p className="note" style={{ marginLeft: 0 }}>
            The same agent and the same guardrails the simulation uses, byte for byte — there is
            no <code>if (live)</code> anywhere above the execution layer. Retries create real
            orders; customer contact creates real payment links with openable URLs.
          </p>

          <div className="live-cases">
            {run.cases.map((c) => (
              <div className="live-case" key={c.caseId}>
                <div className="live-head">
                  <span className="mono">{c.caseId}</span>
                  <strong>{rupees(c.amountPaise)}</strong>
                  <code>{c.reasonCode}</code>
                  <em>{c.recoveryClass}</em>
                </div>
                <div className="live-order mono">order {c.orderId}</div>
                <ul className="lane-steps">
                  {c.actions.map((a) => (
                    <li key={a.step} className={a.verdict === 'allow' ? 'executed' : a.verdict}>
                      <strong>{a.decided.replace(/_/g, ' ')}</strong>
                      {a.channel ? ` · ${a.channel}` : ''}
                      {a.verdict !== 'allow' ? ` — ${a.verdict} (${a.rule})` : ''}
                      {a.razorpay?.['payment_link_id'] && (
                        <div className="mono live-id">
                          {a.razorpay['payment_link_id']}
                          {a.razorpay['short_url'] && (
                            <>
                              {' · '}
                              <a href={a.razorpay['short_url']} target="_blank" rel="noreferrer">
                                {a.razorpay['short_url']}
                              </a>
                            </>
                          )}
                        </div>
                      )}
                      {a.razorpay?.['order_id'] && (
                        <div className="mono live-id">{a.razorpay['order_id']}</div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <p className="note" style={{ marginLeft: 0, marginTop: 20 }}>
            <strong>This is not a measurement.</strong> Five hand-driven cases cannot support a
            recovery rate; the statistics above come from the seeded simulator. What this shows is
            that the same policy drives real API calls. In this run the initial failure reasons
            are seeded — driving a browser per case is not automatable — while every recovery{' '}
            <em>action</em> is a real call. Test mode throughout; no money moved.
          </p>
        </>
      )}
    </>
  );
}

export { STRATEGY_ORDER, seriesColor };
