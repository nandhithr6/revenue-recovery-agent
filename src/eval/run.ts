import { formatINR } from '../domain/types.js';
import { BASELINE_STRATEGIES } from '../policies/baselines.js';
import type { Strategy } from '../policies/types.js';
import { generateCohort, summariseCohort } from '../sim/generator.js';
import { DEFAULT_COSTS, getScenario, SCENARIO_IDS } from '../sim/scenario.js';
import { runCohort, type RunResult } from './engine.js';
import { breakdownByClass, score, type Metrics } from './metrics.js';

/**
 * `npm run eval -- [scenarioId]`
 *
 * Runs every registered strategy against one simulated cohort and prints the
 * comparison. Same cohort, same seed, same costs and same guardrails for every
 * strategy, so the only variable is the policy.
 */

/** Fixed clock so runs are reproducible across days. */
const SIMULATION_START = Date.parse('2026-09-01T00:00:00+05:30');

const STRATEGIES: readonly Strategy[] = [...BASELINE_STRATEGIES];

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const ratio = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '--');

const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length));
const padLeft = (s: string, w: number): string =>
  s.length >= w ? s : ' '.repeat(w - s.length) + s;

function printTable(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (i === 0 ? pad(c, widths[i]!) : padLeft(c, widths[i]!))).join('  ');

  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

function main(): void {
  const requested = process.argv[2] ?? 'baseline-week';

  if (requested === '--list') {
    console.log('Scenarios:');
    for (const id of SCENARIO_IDS) console.log(`  ${id}`);
    return;
  }

  const scenario = getScenario(requested);
  const events = generateCohort(scenario, SIMULATION_START);
  const summary = summariseCohort(events);

  console.log(`\n=== ${scenario.name} (${scenario.id}) ===`);
  console.log(scenario.description);
  console.log(
    `\nCohort: ${summary.count} loss events, ${formatINR(summary.totalAtRiskPaise)} at risk (seed ${scenario.seed})`,
  );

  const classRows = Object.entries(summary.byRecoveryClass).sort((a, b) => b[1] - a[1]);
  console.log('\nBy recovery class:');
  printTable(
    ['Class', 'Cases', 'Share'],
    classRows.map(([cls, n]) => [cls, String(n), pct(n / summary.count)]),
  );

  // Run each strategy exactly once and keep everything: the comparison, the
  // per-class breakdown and the ledger all read from the same run.
  const runs: RunResult[] = STRATEGIES.map((s) =>
    runCohort(events, s, DEFAULT_COSTS, scenario.seed + 1),
  );
  const results: Metrics[] = runs.map(score);

  const best = results.reduce((a, b) => (b.netValuePaise > a.netValuePaise ? b : a));

  console.log('\nStrategy comparison:');
  printTable(
    ['Strategy', 'Recovered', 'Spent', 'Net value', 'Rate', 'Retries/rec', 'Spam', 'Violations'],
    results.map((m) => [
      m.strategyId === best.strategyId ? `* ${m.strategyName}` : `  ${m.strategyName}`,
      formatINR(m.recoveredPaise),
      formatINR(m.costPaise),
      formatINR(m.netValuePaise),
      pct(m.recoveryRate),
      ratio(m.retriesPerRecovery),
      String(m.spamPoints),
      String(m.complianceViolations),
    ]),
  );
  console.log(`\n  * best by net value: ${best.strategyName}`);

  console.log('\nGuardrail activity:');
  printTable(
    ['Strategy', 'Blocked', 'Deferred', 'Contacts', 'Spam/lakh recovered'],
    results.map((m) => [
      m.strategyName,
      String(m.blockedActions),
      String(m.deferrals),
      String(m.totalContacts),
      m.recoveredPaise === 0 ? '--' : m.spamPerLakhRecovered.toFixed(1),
    ]),
  );

  // Which rules actually bit, aggregated across strategies.
  const allRules: Record<string, number> = {};
  for (const m of results) {
    for (const [rule, n] of Object.entries(m.ruleTally)) {
      allRules[rule] = (allRules[rule] ?? 0) + n;
    }
  }
  const ruleRows = Object.entries(allRules).sort((a, b) => b[1] - a[1]);
  if (ruleRows.length > 0) {
    console.log('\nGuardrail rules fired:');
    printTable(['Rule', 'Times'], ruleRows.map(([r, n]) => [r, String(n)]));
  }

  for (const run of runs) {
    if (run.strategyId === 'do-nothing') continue;
    console.log(`\n${run.strategyName} -- where the effort went:`);
    printTable(
      ['Class', 'Cases', 'Recovered', 'Rate', 'Retries', 'Net value'],
      breakdownByClass(run).map((r) => [
        r.recoveryClass,
        String(r.cases),
        String(r.recovered),
        pct(r.recoveryRate),
        String(r.retries),
        formatINR(r.netValuePaise),
      ]),
    );
  }

  console.log('');
}

main();
