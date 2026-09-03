import type { LiveDecline, LiveRun, Novelty, Robustness, Sensitivity } from './types';

/**
 * The sections that answer "how do you know?" rather than "what happened?"
 *
 * Robustness answers "did you get lucky once?". Sensitivity answers "does your
 * answer depend on a constant you chose?". Novelty answers a DIFFERENT
 * question again -- "what happens on a case shaped like nothing in the five
 * scenarios above" -- and is deliberately never blended with the other two:
 * it is a safety measure, not a revenue measure, and its numbers (safe/unsafe
 * counts on hand-authored adversarial cases) have no ₹ figure to compare
 * against the financial benchmark's. The live section answers "does any of
 * this touch a real payment system?".
 *
 * All four read from files produced by separate commands. When a command has
 * not been run, the section says so plainly instead of vanishing — a missing
 * proof should be visible, not silently absent.
 */

const lakh = (paise: number): string => `₹${(paise / 10_000_000).toFixed(2)}L`;
const rupees = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

const STRATEGY_ORDER = ['do-nothing', 'naive-retry', 'fixed-dunning', 'agent-adaptive', 'agent-rules'];

function NotRun({ cmd }: { cmd: string }) {
  return (
    <p className="note" style={{ marginLeft: 0 }}>
      Not run yet. Produce it with <code>{cmd}</code>, then re-run{' '}
      <code>npm run eval:all</code>.
    </p>
  );
}

const CUSTOM_STRATEGY_LABEL: Record<string, string> = {
  'agent-adaptive': 'Adaptive agent',
  'agent-rules': 'Reason-aware agent',
};

export function RobustnessSection({ data }: { data: Robustness | null }) {
  if (!data) return <NotRun cmd="npm run eval:robust" />;

  const combinedPct = ((data.combinedCustomWins / data.totalRuns) * 100).toFixed(1);
  const customIds = Object.keys(data.customStrategyWins).sort(
    (a, b) => STRATEGY_ORDER.indexOf(a) - STRATEGY_ORDER.indexOf(b),
  );

  return (
    <>
      <div className="headline">
        <span className="big">
          {data.combinedCustomWins}<span className="of">/{data.totalRuns}</span>
        </span>
        <p>
          independent cohorts where one of our two strategies posted the highest net value —{' '}
          <strong>{combinedPct}%</strong>. {data.scenarios.length} scenarios × {data.seeds} seeds ×{' '}
          {data.cohortSize} cases, every cohort and every engine roll independently reseeded.
        </p>
      </div>

      <p className="note" style={{ marginLeft: 0 }}>
        {customIds.map((id, i) => (
          <span key={id}>
            {i > 0 ? ', ' : ''}
            <strong>{CUSTOM_STRATEGY_LABEL[id] ?? id}</strong> won{' '}
            {((data.customStrategyWins[id]! / data.totalRuns) * 100).toFixed(1)}%
          </span>
        ))}{' '}
        of the 250 on its own.
      </p>

      <div className="table-scroll">
      <table className="ledger">
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Strategy</th>
            <th>Mean</th>
            <th>p10</th>
            <th>p90</th>
            <th>Std dev</th>
            <th>Best baseline mean</th>
            <th>Wins</th>
          </tr>
        </thead>
        <tbody>
          {data.scenarios.flatMap((s) => {
            const baselineBest = s.strategies
              .filter((x) => !customIds.includes(x.strategyId))
              .reduce((a, b) => (b.netValue.mean > a.netValue.mean ? b : a));
            return customIds.map((id) => {
              const strat = s.strategies.find((x) => x.strategyId === id);
              if (!strat) return null;
              const perfect = strat.wins === strat.runs;
              return (
                <tr key={`${s.scenarioId}-${id}`} className={id === 'agent-adaptive' ? 'lead' : undefined}>
                  <td>{id === customIds[0] ? s.scenarioName : ''}</td>
                  <td>{CUSTOM_STRATEGY_LABEL[id] ?? id}</td>
                  <td className="money">{lakh(strat.netValue.mean)}</td>
                  <td className="money">{lakh(strat.netValue.p10)}</td>
                  <td className="money">{lakh(strat.netValue.p90)}</td>
                  <td className="money">±{lakh(strat.netValue.stdDev)}</td>
                  <td className="money">{lakh(baselineBest.netValue.mean)}</td>
                  <td className="money">
                    <span className={perfect ? 'zero' : undefined}>
                      {strat.wins}/{strat.runs}
                    </span>
                  </td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
      </div>

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

      <div className="table-scroll">
      <table className="ledger">
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Strategy</th>
            {first.adaptive.points.map((p) => (
              <th key={p.pricePaise}>{rupees(p.pricePaise)}</th>
            ))}
            <th>Winner changes?</th>
          </tr>
        </thead>
        <tbody>
          {data.scenarios.flatMap((s) =>
            (['agent-adaptive', 'agent-rules'] as const).map((id) => (
              <tr key={`${s.scenarioId}-${id}`} className={id === 'agent-adaptive' ? 'lead' : undefined}>
                <td>{id === 'agent-adaptive' ? s.scenarioName : ''}</td>
                <td>{CUSTOM_STRATEGY_LABEL[id]}</td>
                {s.adaptive.points.map((p) => (
                  <td key={p.pricePaise} className="money">
                    {lakh(p.byStrategy[id] ?? 0)}
                  </td>
                ))}
                <td className="money">
                  {id === 'agent-adaptive' ? (
                    <span className={s.adaptive.flipped ? undefined : 'zero'}>
                      {s.adaptive.flipped ? 'yes' : 'no'}
                    </span>
                  ) : (
                    ''
                  )}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      </div>

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

const CATEGORY_LABEL: Record<string, string> = {
  'unknown reason code': 'Unknown reason code',
  'malformed/incomplete context': 'Malformed / incomplete context',
  'contradictory state': 'Contradictory state',
  'unexpected previous outcome': 'Unexpected previous outcome',
  'previously-valid action unavailable': 'Previously-valid action unavailable',
  'unusual amount': 'Unusual amount',
  'unfamiliar combination of valid attributes': 'Unfamiliar combination of valid attributes',
};

export function NoveltySection({ data }: { data: Novelty | null }) {
  if (!data) return <NotRun cmd="npm run eval:novelty" />;

  return (
    <>
      <div className="headline">
        <span className="big" style={{ color: data.unsafe === 0 ? undefined : 'var(--critical)' }}>
          {data.safe}
          <span className="of">/{data.totalCases}</span>
        </span>
        <p>
          hand-authored adversarial cases handled safely — unknown reason codes, malformed context,
          contradictory bookkeeping, amounts and combinations none of the five scenarios above ever
          produce. This is a{' '}
          <strong>safety measure, not a revenue measure</strong> — there is no ₹ figure here, on
          purpose: a genuinely novel case has no ground-truth recovery curve to score against (see{' '}
          <code>sim/recovery-model.ts</code>), so this checks that the agent stays safe rather than
          inventing a number for what it can't honestly know.
        </p>
      </div>

      <div className="table-scroll">
      <table className="ledger">
        <thead>
          <tr>
            <th>Category</th>
            <th>Case</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {data.results.map((r) => (
            <tr key={r.id}>
              <td>{CATEGORY_LABEL[r.category] ?? r.category}</td>
              <td className="mono">{r.id}</td>
              <td>
                <span className={r.safe ? 'zero' : undefined} title={r.detail}>
                  {r.safe ? 'safe' : 'UNSAFE'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <p className="note" style={{ marginLeft: 0, marginTop: 18 }}>
        Guardrail-mediated blocks across these adversarial fixtures (a rule catching a proposal is a
        normal, healthy outcome here, not a failure): <strong>{data.guardrailBlocks}</strong>.
        Compliance violations — an action executing that a guardrail should have refused, which is
        structurally impossible; see the boundary test in <code>novelty.test.ts</code>:{' '}
        <strong>{data.complianceViolations}</strong>.
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
            A genuine decline, straight from the API <span className="live-badge">REAL RAZORPAY API</span>
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
          <h3 className="sub-h">
            Recovery actions as real API calls <span className="live-badge">REAL RAZORPAY API</span>
          </h3>
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
            <strong>Not a measurement:</strong> five hand-driven cases cannot support a recovery
            rate — the statistics come from the seeded simulator above. Test mode throughout; no
            money moved.
          </p>
          <details className="why-panel" style={{ marginTop: 4 }}>
            <summary>What this run does and doesn't prove, and why voice never appears here</summary>
            <p className="note" style={{ marginLeft: 0 }}>
              What this shows is that the same policy drives real API calls — initial failure
              reasons are seeded here since driving a browser per case isn't automatable, but every
              recovery <em>action</em> is a real call.
            </p>
            <p className="note" style={{ marginLeft: 0, marginTop: 10 }}>
              <strong>Why voice never appears above:</strong> Razorpay's Payment Links API can
              notify on email and WhatsApp, so there's a real endpoint to hit — it offers no
              outbound voice calling at all, so this customer's consent is{' '}
              <code>voice: false</code> for the live path and the agent never proposes it here.
              Voice stays simulated everywhere in this project (
              <code>sim/voice-signal-model.ts</code>), not by choice but because there's nothing to
              build against — and no paid third-party calling service is used either way.
            </p>
          </details>
        </>
      )}
    </>
  );
}

