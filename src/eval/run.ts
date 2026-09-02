import { formatINR, type Paise } from '../domain/types.js';
import { BASELINE_STRATEGIES } from '../policies/baselines.js';
import type { Strategy } from '../policies/types.js';
import { generateCohort, summariseCohort } from '../sim/generator.js';
import { DEFAULT_COSTS, getScenario, SCENARIO_IDS } from '../sim/scenario.js';
import { runCohort } from './engine.js';
import { breakdownByClass, score, type Metrics } from './metrics.js';

/**
 * `npm run eval -- [scenarioId]`
 *
 * Runs every registered strategy against one simulated cohort and prints the
 * comparison. Same cohort, same seed, same costs for every strategy.
 */

/** Fixed clock so runs are reproducible across days. */
const SIMULATION_START = Date.parse('2026-09-01T00:00:00+05:30');

const STRATEGIES: readonly Strategy[] = [...BASELINE_STRATEGIES];

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const ratio = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '--');

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
function padLeft(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

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

function reportComparison(all: readonly Metrics[]): void {
  const best = all.reduce((a, b) => (b.netValuePaise > a.netValuePaise ? b : a));

  printTable(
    ['Strategy', 'Recovered', 'Spent', 'Net value', 'Rate', 'Retries/rec', 'Contacts/rec', 'Return'],
    all.map((m) => [
      m.strategyId === best.strategyId ? `* ${m.strategyName}` : `  ${m.strategyName}`,
      formatINR(m.recoveredPaise),
      formatINR(m.costPaise),
      formatINR(m.netValuePaise),
      pct(m.recoveryRate),
      ratio(m.retriesPerRecovery),
      ratio(m.contactsPerRecovery),
      ratio(m.returnOnSpend),
    ]),
  );

  console.log(`\n  * best by net value: ${best.strategyName}`);
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

  const results = STRATEGIES.map((s) =>
    score(runCohort(events, s, DEFAULT_COSTS, scenario.seed + 1)),
  );

  console.log('\nStrategy comparison:');
  reportComparison(results);

  // Where did the effort go? This is the interesting part: two strategies can
  // post similar headline numbers while spending very differently.
  for (const strategy of STRATEGIES) {
    if (strategy.id === 'do-nothing') continue;
    const run = runCohort(events, strategy, DEFAULT_COSTS, scenario.seed + 1);
    const rows = breakdownByClass(run);
    console.log(`\n${strategy.name} -- where the effort went:`);
    printTable(
      ['Class', 'Cases', 'Recovered', 'Rate', 'Retries', 'Net value'],
      rows.map((r) => [
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
