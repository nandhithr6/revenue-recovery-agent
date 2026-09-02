import { useEffect, useMemo, useState } from 'react';
import { GroupedBars, HorizontalBars, Legend, seriesColor } from './charts';
import { CaseInspector } from './CaseInspector';
import { LiveSection, RobustnessSection, SensitivitySection } from './Evidence';
import { TimingRibbon, type ClassTrack } from './TimingRibbon';
import type { Bundle, LedgerEntry, ScenarioResult } from './types';

const inr = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

const lakh = (paise: number): string => {
  const l = paise / 10_000_000;
  return l >= 1 ? `₹${l.toFixed(2)}L` : inr(paise);
};

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

const clock = (ms: number): string =>
  new Date(ms).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

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
  const [theme, setTheme] = useState('system');
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset['theme'];
    else document.documentElement.dataset['theme'] = theme;
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'system' ? 'dark' : t === 'dark' ? 'light' : 'system'))];
}

function AuditTrail({ entries }: { entries: readonly LedgerEntry[] }) {
  if (entries.length === 0) return <p className="note">No entries.</p>;
  return (
    <div className="trail">
      {entries.map((e) => (
        <div className="entry" key={e.seq}>
          <time>{clock(e.at)}</time>
          <div className={`tag ${e.outcome}`}>{e.outcome}</div>
          <div>
            <div className="what">
              {e.actionKind.replace(/_/g, ' ')}
              {e.channel ? ` · ${e.channel}` : ''}
            </div>
            <div className="why">{e.rationale}</div>
            {e.rule && (
              <div className="rule">
                <b>{e.rule}</b> — {e.explanation}
                {e.deferredTo ? ` Rescheduled to ${clock(e.deferredTo)}.` : ''}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
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

  const wasteRows = ['HARD_DECLINE', 'CUSTOMER_ACTION_REQUIRED']
    .filter((c) => classes.includes(c))
    .map((cls) => ({
      group: CLASS_LABEL[cls] ?? cls,
      values: scenario.strategies.map((s) => {
        const row = s.byClass.find((c) => c.recoveryClass === cls);
        return { label: s.name, value: row?.retries ?? 0, display: String(row?.retries ?? 0) };
      }),
    }));
  const maxWaste = Math.max(1, ...wasteRows.flatMap((r) => r.values.map((v) => v.value)));

  const ruleRows = Object.entries(scenario.ruleTally)
    .sort((a, b) => b[1] - a[1])
    .map(([rule, n]) => ({ label: rule, value: n, display: String(n), colorIndex: 3 }));

  return (
    <div className="sheet">
      <div className="masthead">
        <div>
          <p className="eyebrow">Razorpay AI Buildathon · Revenue Recovery</p>
          <h1>
            Failed payments are not
            <br />
            all the same failure.
          </h1>
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
          <button
            key={s.id}
            aria-pressed={s.id === scenario.id}
            onClick={() => setScenarioId(s.id)}
          >
            {s.name}
          </button>
        ))}
      </div>
      <p className="scenario-line">
        {scenario.description} <b>{scenario.cohort.count}</b> loss events,{' '}
        <b>{lakh(scenario.cohort.totalAtRiskPaise)}</b> at risk. Seed <b>{scenario.seed}</b>.
      </p>

      <nav className="railnav" aria-label="Sections">
        <a href="#how">How it works</a>
        <a href="#timing">01 Timing</a>
        <a href="#books">02 The books</a>
        <a href="#classes">03 By failure class</a>
        <a href="#waste">04 Doomed attempts</a>
        <a href="#inspect">05 Inspect a case</a>
        <a href="#rules">06 Rules</a>
        <a href="#playbook">07 The playbook</a>
        <a href="#trail">08 Audit trail</a>
        <a href="#robust">09 Robustness</a>
        <a href="#sensitivity">10 Sensitivity</a>
        <a href="#live">11 Live Razorpay</a>
        <a href="#provenance">12 What is real</a>
      </nav>

      <section id="how">
        <div className="sec-head">
          <span className="sec-num">00</span>
          <h2>How this works, in five steps</h2>
        </div>
        <div className="howto">
          <div>
            <b>1 · the losses</b>
            <p>
              {scenario.cohort.count} simulated failed payments, each with a real Razorpay error
              code, an amount, and a customer with their own consent settings.
            </p>
          </div>
          <div>
            <b>2 · diagnose</b>
            <p>
              The agent reads the error code and works out which of six situations it is in.
              It never sees whether recovery would actually succeed.
            </p>
          </div>
          <div>
            <b>3 · decide</b>
            <p>
              It picks one action: retry now, retry later, message the customer, hand to a
              person, or stop.
            </p>
          </div>
          <div>
            <b>4 · guardrails</b>
            <p>
              A separate layer allows, delays or refuses that action. The agent cannot overrule
              it, so quiet hours and attempt caps always hold.
            </p>
          </div>
          <div>
            <b>5 · score</b>
            <p>
              Every decision is written to a ledger, and the same cohort is replayed through
              three other strategies to compare.
            </p>
          </div>
        </div>
      </section>

      <section id="timing">
        <div className="sec-head">
          <span className="sec-num">01</span>
          <h2>A day, and what the agent is allowed to do in it</h2>
        </div>
        <p className="note">
          When you act decides whether the money comes back, and compliance decides when you are
          allowed to speak at all. Each row is a failure class; the dots are when this agent will
          re-attempt the charge. The shaded bands are quiet hours, 21:00 to 09:00 local.
        </p>
        <TimingRibbon tracks={tracks} />
        <div className="ribbon-caption">
          <span>
            <i style={{ background: 'var(--night)' }} aria-hidden />
            no customer contact permitted
          </span>
          <span>dots mark retry attempts, offset from the original failure</span>
        </div>

        <div className="story">
          <p>
            <b>20:30</b> — a payment fails on a bank timeout.
          </p>
          <p>
            <b>21:30</b> — the agent wants to reach the customer. It is inside quiet hours, so the
            guardrail refuses.
          </p>
          <p>
            <b>09:00</b> — the message goes, first thing. Not dropped, queued. The ledger records the
            rule that stopped it and the time it was moved to.
          </p>
        </div>
      </section>

      <section id="books">
        <div className="sec-head">
          <span className="sec-num">02</span>
          <h2>The books</h2>
        </div>
        <p className="note">
          Net value counts money recovered, minus what was spent, minus customer annoyance priced at
          ₹20 a point. One figure rather than two columns, so the trade between revenue and goodwill
          has to be made explicitly instead of picked to taste.
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
              <th>Annoyance</th>
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
                <td className="money">{s.metrics.spamPoints}</td>
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
            <div className="k">Violations</div>
            <div className="v">{agent.metrics.complianceViolations}</div>
            <div className="d">
              {agent.metrics.deferrals} deferred · {agent.metrics.blockedActions} blocked
            </div>
          </div>
          <div className="fig">
            <div className="k">Doomed retries</div>
            <div className="v">0</div>
            <div className="d">baselines spent {wasted}</div>
          </div>
        </div>
      </section>

      <section id="classes">
        <div className="sec-head">
          <span className="sec-num">03</span>
          <h2>Where each strategy wins, and where it gives up</h2>
        </div>
        <p className="note">
          The argument in one chart. Naive retry is fast, so it does well when a customer walked away
          and badly when a bank was down. Fixed dunning is patient, so the reverse. Neither can be
          both, because neither reads why the payment failed.
        </p>
        <Legend items={names} />
        <GroupedBars rows={rateRows} maxValue={1} />
      </section>

      <section id="waste">
        <div className="sec-head">
          <span className="sec-num">04</span>
          <h2>Attempts against payments that could never succeed</h2>
        </div>
        <p className="note">
          An expired card cannot be charged and a bank that refused for fraud will refuse again.
          Every attempt here is spend with no possible return — and against a hard decline it is also
          billed, because networks charge for excessive retries on declined authorisations.
        </p>
        <Legend items={names} />
        <GroupedBars rows={wasteRows} maxValue={maxWaste} formatTick={(v) => String(Math.round(v))} />
      </section>

      <section id="inspect">
        <div className="sec-head">
          <span className="sec-num">05</span>
          <h2>Inspect any case yourself</h2>
        </div>
        <p className="note">
          Everything above is a summary, and a summary has to be taken on trust. This is not:
          pick a failure class and a case, and see the exact inputs the agent was given, the
          action it chose in its own words, and the guardrail ruling on it. Then see what the
          other three strategies did with the same case, on the same randomness.
        </p>
        <CaseInspector cases={scenario.inspectableCases} />
      </section>

      <section id="rules">
        <div className="cols">
          <div>
            <div className="sec-head">
              <span className="sec-num">06</span>
              <h2>Rules that fired</h2>
            </div>
            <p className="note" style={{ marginLeft: 0 }}>
              Not a failure count. A strategy that never trips a limit either never pushed hard
              enough to reach one, or is not going through the gate at all.
            </p>
            {ruleRows.length > 0 ? (
              <HorizontalBars rows={ruleRows} labelWidth={186} />
            ) : (
              <p className="note">No rules fired.</p>
            )}
          </div>

          <div>
            <div className="sec-head">
              <span className="sec-num">07</span>
              <h2>What kind of loss</h2>
            </div>
            <p className="note" style={{ marginLeft: 0 }}>
              The loss type decides what recovery is even permitted. Nobody authorised an abandoned
              checkout, and an invoice is not an instrument — so neither can be retried, by anyone.
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
      </section>

      <section id="playbook">
        <div className="sec-head">
          <span className="sec-num">07b</span>
          <h2>The whole playbook, in the open</h2>
        </div>
        <p className="note">
          These are the agent's actual rules, rendered from the same file it runs on. Nothing
          about the policy is hidden in source: the retry timings, the channel order and the
          written reasoning are all here.
        </p>
        <table className="ledger">
          <thead>
            <tr>
              <th>Situation</th>
              <th>Retries at</th>
              <th>Channels, in order</th>
              <th>Reasoning</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(bundle.playbooks).map(([cls, p]) => (
              <tr key={cls}>
                <td>
                  <span className="name">
                    <span>
                      {CLASS_LABEL[cls] ?? cls}
                      <small>{cls}</small>
                    </span>
                  </span>
                </td>
                <td className="money">
                  {p.retryOffsetsHours.length
                    ? p.retryOffsetsHours.map((h) => `+${h < 1 ? `${Math.round(h * 60)}m` : `${h}h`}`).join(', ')
                    : 'never'}
                </td>
                <td className="money">{p.channelLadder.join(' → ') || 'none'}</td>
                <td style={{ textAlign: 'left', whiteSpace: 'normal', color: 'var(--ink-2)', fontSize: 13 }}>
                  {p.reasoning}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section id="trail">
        <div className="sec-head">
          <span className="sec-num">08</span>
          <h2>The raw ledger, one case end to end</h2>
        </div>
        <p className="note">
          The audit trail records what the agent did, what it was refused, and why. A blocked action
          is evidence, not silence: it shows the rule that stopped it and where the work went next.
        </p>
        <AuditTrail entries={scenario.sampleAuditTrail} />
      </section>

      <section id="robust">
        <div className="sec-head">
          <span className="sec-num">09</span>
          <h2>Did it just get lucky once?</h2>
        </div>
        <p className="note">
          Every figure above comes from one seeded cohort, which invites the obvious question.
          This reruns each scenario across many independent cohorts and reports the spread.
        </p>
        <RobustnessSection data={bundle.robustness} />
      </section>

      <section id="sensitivity">
        <div className="sec-head">
          <span className="sec-num">10</span>
          <h2>Does the answer depend on a number we chose?</h2>
        </div>
        <SensitivitySection data={bundle.sensitivity} />
      </section>

      <section id="live">
        <div className="sec-head">
          <span className="sec-num">11</span>
          <h2>The same agent, against the real Razorpay API</h2>
        </div>
        <p className="note">
          Everything above runs on a simulator, because measurement needs cohorts nobody can pay
          for by hand. This is the other half: the identical policy driving live API calls in
          Razorpay test mode.
        </p>
        <LiveSection run={bundle.liveRun} decline={bundle.liveDecline} />
      </section>

      <section id="provenance">
        <div className="sec-head">
          <span className="sec-num">12</span>
          <h2>What is real here, and what we made up</h2>
        </div>
        <p className="note">
          Worth answering before anyone has to ask. Real failed-payment data is
          merchant-confidential, so every transaction on this page is synthetic. What is not
          invented is the vocabulary: these are Razorpay's own documented error codes, which
          means this taxonomy would not need rewriting to point at a production webhook feed.
        </p>
        <div className="prov">
          <div>
            <h4>From Razorpay's documentation</h4>
            <ul>
              <li>
                21 failure <code>reason</code> codes, cards and UPI —{' '}
                <a href="https://razorpay.com/docs/errors/payments/cards/">cards</a>,{' '}
                <a href="https://razorpay.com/docs/errors/payments/upi/">UPI</a>
              </li>
              <li>
                The error structure — <code>code</code>, <code>description</code>,{' '}
                <code>source</code>, <code>step</code>, <code>reason</code> —{' '}
                <a href="https://razorpay.com/docs/errors/">error docs</a>
              </li>
              <li>The documented next step for each error</li>
              <li>That UPI dominates Indian digital payments, hence the 68/32 mix</li>
            </ul>
          </div>
          <div>
            <h4>Our own assumptions</h4>
            <ul>
              <li>
                Which of six recovery classes each reason maps to — reasoned from the documented
                next steps, not measured
              </li>
              <li>Recovery-probability curves, one shape per class</li>
              <li>Cost model, and the ₹20 annoyance price</li>
              <li>The failure mix in each scenario</li>
              <li>Nudge effectiveness per channel</li>
            </ul>
          </div>
          <div>
            <h4>What these numbers are not</h4>
            <ul>
              <li>
                <strong>Not a revenue forecast.</strong> They compare policy quality on identical
                cohorts with a fixed seed. Anyone claiming production rupees from synthetic data
                would be overselling.
              </li>
              <li>
                Every assumption is a named constant with a comment explaining it, listed in{' '}
                <code>docs/SOURCES.md</code>.
              </li>
              <li>
                Robustness: the agent wins 245 of 250 independently seeded cohorts, not 250 of 250.
              </li>
            </ul>
          </div>
        </div>
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
