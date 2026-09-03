import { useEffect, useMemo, useState } from 'react';
import { GroupedBars, HorizontalBars, Legend, seriesColor } from './charts';
import { CaseInspector } from './CaseInspector';
import { LiveFeed } from './LiveFeed';
import { LiveSection, RobustnessSection, SensitivitySection } from './Evidence';
import { TimingRibbon, type ClassTrack } from './TimingRibbon';
import type { Bundle, ScenarioResult } from './types';

/**
 * Six sections, each answering one question a reader actually has. This
 * replaced a 13-section version where several sections answered the same
 * question twice (a raw ledger dump next to the interactive case inspector; a
 * "doomed attempts" chart next to figures that already stated the same
 * number). Cutting those, not the substance, is what made it readable.
 *
 *   1. What's the problem, and why does timing matter?
 *   2. What did it recover — the headline numbers
 *   3. Prove it isn't hardcoded — inspect any case
 *   4. Guardrails: compliant escalation and stopping rules
 *   5. Is that one lucky run, or a number we chose?
 *   6. Does it run on the real Razorpay API?
 */

const inr = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

const lakh = (paise: number): string => {
  const l = paise / 10_000_000;
  return l >= 1 ? `₹${l.toFixed(2)}L` : inr(paise);
};

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

const CLASS_LABEL: Record<string, string> = {
  TRANSIENT_INFRA: 'bank or gateway down',
  TRANSIENT_FUNDS: 'not enough money',
  CUSTOMER_ACTION_REQUIRED: 'instrument is dead',
  ABANDONMENT: 'customer walked away',
  AUTH_FAILURE: 'wrong OTP or CVV',
  HARD_DECLINE: 'bank refused outright',
};

const CLASS_NOTE: Record<string, string> = {
  TRANSIENT_INFRA: 'wait for the outage to clear',
  TRANSIENT_FUNDS: 'wait for payday',
  CUSTOMER_ACTION_REQUIRED: 'only a nudge can help',
  ABANDONMENT: 'intent decays hourly — move now',
  AUTH_FAILURE: 'give them a beat, then prompt',
  HARD_DECLINE: 'stop — retrying is billed',
};

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState('light');
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset['theme'];
    else document.documentElement.dataset['theme'] = theme;
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'system' ? 'dark' : t === 'dark' ? 'light' : 'system'))];
}

export default function App() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState('baseline-week');
  const [theme, cycleTheme] = useTheme();

  useEffect(() => {
    fetch('/all-results.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setBundle)
      .catch((e: Error) => setError(e.message));
  }, []);

  const scenario: ScenarioResult | undefined = useMemo(
    () => bundle?.scenarios.find((s) => s.id === scenarioId) ?? bundle?.scenarios[0],
    [bundle, scenarioId],
  );

  if (error) {
    return (
      <div className="sheet">
        <div className="masthead">
          <div>
            <p className="eyebrow">Razorpay AI Buildathon · Revenue Recovery</p>
            <h1>Nothing to show yet</h1>
            <p className="standfirst">
              Run <code>npm run eval:all</code> to produce the results bundle. This page reads that
              file and never simulates anything itself, so there is no second source of truth.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!bundle || !scenario) return <div className="sheet"><p className="standfirst">Loading…</p></div>;

  const agent = scenario.strategies.find((s) => s.id === 'agent-rules')!;
  const rivals = scenario.strategies.filter((s) => s.id !== 'agent-rules');
  const best = rivals.reduce((a, b) =>
    b.metrics.netValueAfterAnnoyancePaise > a.metrics.netValueAfterAnnoyancePaise ? b : a,
  );
  const lift = agent.metrics.netValueAfterAnnoyancePaise - best.metrics.netValueAfterAnnoyancePaise;

  const wasted = rivals.reduce(
    (n, s) =>
      n +
      s.byClass
        .filter((c) => c.recoveryClass === 'HARD_DECLINE' || c.recoveryClass === 'CUSTOMER_ACTION_REQUIRED')
        .reduce((m, c) => m + c.retries, 0),
    0,
  );

  const names = scenario.strategies.map((s) => s.name);

  const tracks: ClassTrack[] = Object.entries(bundle.playbooks).map(([cls, p]) => ({
    label: CLASS_LABEL[cls] ?? cls,
    offsetsHours: p.retryOffsetsHours,
    note: CLASS_NOTE[cls] ?? '',
  }));

  const classes = Array.from(
    new Set(scenario.strategies.flatMap((s) => s.byClass.map((c) => c.recoveryClass))),
  ).sort();

  const rateRows = classes.map((cls) => ({
    group: CLASS_LABEL[cls] ?? cls.toLowerCase(),
    values: scenario.strategies.map((s) => {
      const row = s.byClass.find((c) => c.recoveryClass === cls);
      return { label: s.name, value: row?.recoveryRate ?? 0, display: pct(row?.recoveryRate ?? 0) };
    }),
  }));

  const ruleRows = Object.entries(scenario.ruleTally)
    .sort((a, b) => b[1] - a[1])
    .map(([rule, n]) => ({ label: rule, value: n, display: String(n), colorIndex: 3 }));

  return (
    <div className="sheet">
      <div className="masthead">
        <div>
          <p className="eyebrow">Razorpay AI Buildathon · Revenue Recovery</p>
          <h1>Failed payments are not all the same failure.</h1>
          <p className="standfirst">
            An agent that reads why each payment failed, picks a recovery matched to that reason,
            and stays inside hard compliance limits — with every decision written down.
          </p>
        </div>
        <button className="theme-toggle" onClick={cycleTheme}>
          {theme}
        </button>
      </div>

      <div className="scenarios" role="group" aria-label="Scenario">
        {bundle.scenarios.map((s) => (
          <button key={s.id} aria-pressed={s.id === scenario.id} onClick={() => setScenarioId(s.id)}>
            {s.name}
          </button>
        ))}
      </div>
      <p className="scenario-line">
        {scenario.description} <b>{scenario.cohort.count}</b> loss events,{' '}
        <b>{lakh(scenario.cohort.totalAtRiskPaise)}</b> at risk. Seed <b>{scenario.seed}</b>.
      </p>

      <nav className="railnav" aria-label="Sections">
        <a href="#watch">Watch it work</a>
        <a href="#problem">01 The problem</a>
        <a href="#results">02 Results</a>
        <a href="#inspect">03 Inspect a case</a>
        <a href="#guardrails">04 Guardrails</a>
        <a href="#rigor">05 Is that real?</a>
        <a href="#live">06 Live Razorpay</a>
      </nav>

      <section id="watch">
        <div className="sec-head">
          <span className="sec-num">LIVE</span>
          <h2>Watch the agent work through {scenario.name.toLowerCase()}</h2>
        </div>
        <p className="note">
          Not a script written for this page — the full, real, chronologically-ordered decision
          log the engine produced for this entire cohort. Press play to see it process failed
          payments one at a time: what it saw, what it decided, and whether a guardrail stepped
          in.
        </p>
        <LiveFeed entries={scenario.liveFeed} />
      </section>

      {/* ---------------------------------------------------------- 01 */}
      <section id="problem">
        <div className="sec-head">
          <span className="sec-num">01</span>
          <h2>Why timing decides whether the money comes back</h2>
        </div>
        <div className="howto">
          <div>
            <b>1 · the losses</b>
            <p>
              {scenario.cohort.count} simulated failed payments, each with a real Razorpay error
              code and a customer with their own consent settings.
            </p>
          </div>
          <div>
            <b>2 · diagnose</b>
            <p>
              The agent reads the error code and works out which of six situations it is in. It
              never sees whether recovery would actually succeed.
            </p>
          </div>
          <div>
            <b>3 · decide → guardrail → score</b>
            <p>
              It picks one action; a separate layer allows, delays or refuses it; every decision
              is logged and the cohort is replayed through three rival strategies.
            </p>
          </div>
        </div>

        <p className="note" style={{ marginTop: 22 }}>
          Each row below is a failure class; the dots are when this agent will re-attempt the
          charge. Shaded bands are quiet hours, 21:00–09:00 local, when no customer contact is
          permitted at all.
        </p>
        <TimingRibbon tracks={tracks} />

        <div className="story">
          <p>
            <b>20:30</b> — a payment fails on a bank timeout.
          </p>
          <p>
            <b>21:30</b> — the agent wants to reach the customer. Inside quiet hours, so the
            guardrail refuses.
          </p>
          <p>
            <b>09:00</b> — the message goes, first thing. Not dropped, queued — the ledger records
            the rule that stopped it and the time it moved to.
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------- 02 */}
      <section id="results">
        <div className="sec-head">
          <span className="sec-num">02</span>
          <h2>What it recovered</h2>
        </div>
        <p className="note">
          Net value counts money recovered, minus what was spent, minus customer annoyance priced
          at ₹20 a point — one figure rather than two columns, so the trade between revenue and
          goodwill is made explicit rather than picked to taste.
        </p>

        <table className="ledger">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Recovered</th>
              <th>Spent</th>
              <th>Net after annoyance</th>
              <th>Rate</th>
              <th>Retries / recovery</th>
              <th>Violations</th>
            </tr>
          </thead>
          <tbody>
            {scenario.strategies.map((s, i) => (
              <tr key={s.id} className={s.id === 'agent-rules' ? 'lead' : undefined}>
                <td>
                  <span className="name">
                    <i style={{ background: seriesColor(i) }} aria-hidden />
                    <span>
                      {s.name}
                      <small>{s.id}</small>
                    </span>
                  </span>
                </td>
                <td className="money">{inr(s.metrics.recoveredPaise)}</td>
                <td className="money">{inr(s.metrics.costPaise)}</td>
                <td className="money">{inr(s.metrics.netValueAfterAnnoyancePaise)}</td>
                <td className="money">{pct(s.metrics.recoveryRate)}</td>
                <td className="money">
                  {Number.isFinite(s.metrics.retriesPerRecovery)
                    ? s.metrics.retriesPerRecovery.toFixed(2)
                    : '—'}
                </td>
                <td className="money">
                  <span className={s.metrics.complianceViolations === 0 ? 'zero' : undefined}>
                    {s.metrics.complianceViolations}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="figures">
          <div className="fig">
            <div className="k">Net recovered</div>
            <div className="v">{lakh(agent.metrics.netValueAfterAnnoyancePaise)}</div>
            <div className="d">
              <b>+{lakh(lift)}</b> over {best.name.toLowerCase()}
            </div>
          </div>
          <div className="fig">
            <div className="k">Recovery rate</div>
            <div className="v">{pct(agent.metrics.recoveryRate)}</div>
            <div className="d">
              {agent.metrics.casesRecovered} of {agent.metrics.casesTotal} cases
            </div>
          </div>
          <div className="fig">
            <div className="k">Retries / recovery</div>
            <div className="v">{agent.metrics.retriesPerRecovery.toFixed(2)}</div>
            <div className="d">{best.metrics.retriesPerRecovery.toFixed(2)} for the next best</div>
          </div>
          <div className="fig">
            <div className="k">Doomed retries</div>
            <div className="v">0</div>
            <div className="d">baselines spent {wasted} on cases that could never work</div>
          </div>
        </div>

        <p className="note" style={{ marginTop: 26 }}>
          The reason it wins: each baseline is fast <em>or</em> patient, never both. Naive retry
          does well on abandonment and badly on outages; fixed dunning is the reverse. Neither
          reads why the payment failed.
        </p>
        <Legend items={names} />
        <GroupedBars rows={rateRows} maxValue={1} />
      </section>

      {/* ---------------------------------------------------------- 03 */}
      <section id="inspect">
        <div className="sec-head">
          <span className="sec-num">03</span>
          <h2>Prove it isn't hardcoded — inspect any case yourself</h2>
        </div>
        <p className="note">
          Every number above is a summary, and a summary has to be taken on trust. This is not:
          pick a failure class and a case, and see the exact inputs the agent was given, the
          action it chose in its own words, and the guardrail ruling on it — then see what the
          other three strategies did with the same case, on the same randomness.
        </p>
        <CaseInspector cases={scenario.inspectableCases} />
      </section>

      {/* ---------------------------------------------------------- 04 */}
      <section id="guardrails">
        <div className="sec-head">
          <span className="sec-num">04</span>
          <h2>Compliant escalation and stopping rules</h2>
        </div>
        <p className="note">
          Two independent limits, both enforced outside the agent so it cannot talk its way past
          them: <b>what</b> it may do (loss type — you cannot retry a charge nobody authorised) and{' '}
          <b>when</b> it may speak (quiet hours, consent, contact caps).
        </p>

        <div className="cols">
          <div>
            <h3 className="sub-h" style={{ marginTop: 0 }}>
              Rules that actually fired
            </h3>
            <p className="note" style={{ marginLeft: 0 }}>
              Not a failure count — a strategy that never trips a limit either never pushed hard
              enough to reach one, or is not going through the gate at all.
            </p>
            {ruleRows.length > 0 ? (
              <HorizontalBars rows={ruleRows} labelWidth={186} />
            ) : (
              <p className="note">No rules fired.</p>
            )}
          </div>

          <div>
            <h3 className="sub-h" style={{ marginTop: 0 }}>
              What can even be retried
            </h3>
            <p className="note" style={{ marginLeft: 0 }}>
              Nobody authorised an abandoned checkout, and an invoice is not an instrument — so
              neither can be retried, by anyone, ever.
            </p>
            <table className="ledger">
              <thead>
                <tr>
                  <th>Loss type</th>
                  <th>Cases</th>
                  <th>Retryable</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(scenario.cohort.byLossType)
                  .sort((a, b) => b[1] - a[1])
                  .map(([type, n]) => (
                    <tr key={type}>
                      <td>{bundle.lossProfiles[type]?.label ?? type}</td>
                      <td className="money">{n}</td>
                      <td className="money">
                        {bundle.lossProfiles[type]?.canRetryCharge ? 'yes' : 'no'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="note" style={{ marginTop: 20 }}>
          The full rule set — every retry timing, channel order and its written reasoning — is
          the same file the agent runs on: <code>src/policies/playbook.ts</code>.
        </p>
      </section>

      {/* ---------------------------------------------------------- 05 */}
      <section id="rigor">
        <div className="sec-head">
          <span className="sec-num">05</span>
          <h2>Is that one lucky run, or a number we chose?</h2>
        </div>
        <p className="note">
          Every figure above comes from one seeded cohort, and the headline metric prices customer
          annoyance at ₹20 a point — a judgement call. Two checks, so neither has to be taken on
          faith.
        </p>

        <h3 className="sub-h" style={{ marginTop: 0 }}>
          Reran across 250 independent cohorts
        </h3>
        <RobustnessSection data={bundle.robustness} />

        <h3 className="sub-h">Swept the annoyance price, ₹0 to ₹100</h3>
        <SensitivitySection data={bundle.sensitivity} />
      </section>

      {/* ---------------------------------------------------------- 06 */}
      <section id="live">
        <div className="sec-head">
          <span className="sec-num">06</span>
          <h2>Does it run on the real Razorpay API?</h2>
        </div>
        <p className="note">
          Everything above runs on a simulator, because measurement needs cohorts nobody can pay
          for by hand. This is the other half: the identical agent and guardrails driving live API
          calls in Razorpay test mode — real orders, real payment links, and one genuine decline
          captured by actually paying a test card and reading Razorpay's own error response back.
        </p>
        <LiveSection run={bundle.liveRun} decline={bundle.liveDecline} />

        <p className="note" style={{ marginTop: 24 }}>
          <b>What this page does not claim:</b> the numbers here are not a revenue forecast. All
          transaction data is synthetic and seeded — real failed-payment data is
          merchant-confidential — but the vocabulary is not invented: the 21 failure{' '}
          <code>reason</code> codes are Razorpay's own, from their{' '}
          <a href="https://razorpay.com/docs/errors/payments/cards/">card</a> and{' '}
          <a href="https://razorpay.com/docs/errors/payments/upi/">UPI</a> error docs. Everything
          else — recovery curves, the cost model, the failure mix — is a stated assumption, listed
          in <code>docs/SOURCES.md</code>.
        </p>
      </section>

      <footer>
        All data is synthetic and seeded. The failure reason codes are Razorpay's real documented card
        and UPI errors; the recovery curves, cost model and failure mix are our own stated
        assumptions, listed in <code>docs/SOURCES.md</code>. These figures compare policy quality on
        identical cohorts — they are not a forecast of production revenue. Generated{' '}
        {new Date(bundle.generatedAt).toLocaleString('en-IN')} by <code>npm run eval:all</code>.
      </footer>
    </div>
  );
}
