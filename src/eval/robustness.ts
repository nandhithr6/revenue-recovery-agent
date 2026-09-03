import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Paise } from '../domain/types.js';
import { BASELINE_STRATEGIES } from '../policies/baselines.js';
import { createRulesAgent } from '../policies/rules-agent.js';
import { createAdaptiveAgent } from '../policies/adaptive-agent.js';
import type { Strategy } from '../policies/types.js';
import { generateCohort } from '../sim/generator.js';
import { DEFAULT_COSTS, SCENARIO_IDS, getScenario } from '../sim/scenario.js';
import { runCohort } from './engine.js';
import { score } from './metrics.js';

/**
 * `npm run eval:robust`
 *
 * Every result elsewhere in this project comes from one seed per scenario, which
 * invites the obvious question: did the agent win, or did it get lucky once?
 *
 * This runs each scenario across many independent cohorts and reports the spread
 * and the win rate. The claim we want to be able to make is not "the agent
 * recovered more" but "the agent recovered more in N of M independent runs".
 *
 * If the win rate is below 100%, that is reported as-is. An honest 94% is worth
 * more than a suspicious 100%, and hiding the losses would make every other
 * number in the repo less believable.
 */

const SIMULATION_START = Date.parse('2026-09-01T00:00:00+05:30');
const DEFAULT_SEEDS = 50;

/**
 * The same cohort size as the headline runs, deliberately. Using a smaller one
 * here would invite the fair question of why the robustness check ran on
 * different data than the numbers it is supposed to defend.
 */
const COHORT_SIZE = 500;

interface Summary {
  readonly mean: number;
  readonly median: number;
  readonly p10: number;
  readonly p90: number;
  readonly min: number;
  readonly max: number;
  readonly stdDev: number;
}

function summarise(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const at = (q: number): number => sorted[Math.min(n - 1, Math.max(0, Math.floor(q * n)))]!;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;

  return {
    mean,
    median: at(0.5),
    p10: at(0.1),
    p90: at(0.9),
    min: sorted[0]!,
    max: sorted[n - 1]!,
    stdDev: Math.sqrt(variance),
  };
}

export interface StrategyRobustness {
  readonly strategyId: string;
  readonly strategyName: string;
  readonly netValue: Summary;
  readonly recoveryRate: Summary;
  /** Runs in which this strategy posted the highest net value after annoyance. */
  readonly wins: number;
  readonly runs: number;
  readonly complianceViolations: number;
}

export interface ScenarioRobustness {
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly seeds: number;
  readonly strategies: readonly StrategyRobustness[];
}

function runScenario(
  scenarioId: string,
  strategies: readonly Strategy[],
  seeds: number,
): ScenarioRobustness {
  const base = getScenario(scenarioId);

  const netValues = new Map<string, number[]>();
  const rates = new Map<string, number[]>();
  const wins = new Map<string, number>();
  const violations = new Map<string, number>();
  for (const s of strategies) {
    netValues.set(s.id, []);
    rates.set(s.id, []);
    wins.set(s.id, 0);
    violations.set(s.id, 0);
  }

  for (let i = 0; i < seeds; i++) {
    // Reseed the cohort AND the engine. Varying only one of them would hold
    // half the randomness fixed and understate the true spread.
    const seed = base.seed + i * 7919; // a prime stride, to avoid seed aliasing
    const scenario = { ...base, seed, cohortSize: COHORT_SIZE };
    const events = generateCohort(scenario, SIMULATION_START);

    let bestId = '';
    let bestValue = Number.NEGATIVE_INFINITY;

    for (const strategy of strategies) {
      const metrics = score(runCohort(events, strategy, DEFAULT_COSTS, seed + 1));
      netValues.get(strategy.id)!.push(metrics.netValueAfterAnnoyancePaise);
      rates.get(strategy.id)!.push(metrics.recoveryRate);
      violations.set(
        strategy.id,
        violations.get(strategy.id)! + metrics.complianceViolations,
      );

      if (metrics.netValueAfterAnnoyancePaise > bestValue) {
        bestValue = metrics.netValueAfterAnnoyancePaise;
        bestId = strategy.id;
      }
    }

    // `do-nothing` posts exactly zero and can only "win" where every strategy
    // lost money. That is a real outcome worth seeing, so it is not excluded.
    wins.set(bestId, wins.get(bestId)! + 1);
  }

  return {
    scenarioId: base.id,
    scenarioName: base.name,
    seeds,
    strategies: strategies.map((s) => ({
      strategyId: s.id,
      strategyName: s.name,
      netValue: summarise(netValues.get(s.id)!),
      recoveryRate: summarise(rates.get(s.id)!),
      wins: wins.get(s.id)!,
      runs: seeds,
      complianceViolations: violations.get(s.id)!,
    })),
  };
}

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

const lakh = (paise: Paise): string => `${(paise / 10_000_000).toFixed(2)}L`;

async function main(): Promise<void> {
  const seeds = Number(process.argv[2] ?? DEFAULT_SEEDS);
  if (!Number.isFinite(seeds) || seeds < 2) {
    throw new Error(`Seed count must be an integer of at least 2; got "${process.argv[2]}"`);
  }

  const strategies: readonly Strategy[] = [
    ...BASELINE_STRATEGIES,
    createRulesAgent(DEFAULT_COSTS),
    createAdaptiveAgent(DEFAULT_COSTS),
  ];

  const started = Date.now();
  console.log(
    `\nRunning ${SCENARIO_IDS.length} scenarios x ${seeds} seeds x ${strategies.length} strategies` +
      ` (${COHORT_SIZE} cases each)\n`,
  );

  const scenarios = SCENARIO_IDS.map((id) => runScenario(id, strategies, seeds));

  for (const s of scenarios) {
    console.log(`=== ${s.scenarioName} (${s.seeds} seeds) ===`);
    printTable(
      ['Strategy', 'Net value mean', 'p10', 'p90', 'std dev', 'Wins', 'Viol.'],
      s.strategies.map((r) => [
        r.strategyName,
        lakh(r.netValue.mean),
        lakh(r.netValue.p10),
        lakh(r.netValue.p90),
        lakh(r.netValue.stdDev),
        `${r.wins}/${r.runs}`,
        String(r.complianceViolations),
      ]),
    );
    console.log('');
  }

  // The headline: one number that answers "did you get lucky?" Reported per
  // strategy id present, not hardcoded to one -- a second custom strategy
  // (agent-adaptive) joined after this was first written, and a hardcoded id
  // here would have silently kept reporting the wrong one's win rate.
  const totalRuns = scenarios.reduce((n, s) => n + s.seeds, 0);
  const winsById = (id: string): number =>
    scenarios.reduce((n, s) => n + (s.strategies.find((x) => x.strategyId === id)?.wins ?? 0), 0);
  const totalViolations = scenarios.reduce(
    (n, s) => n + s.strategies.reduce((m, x) => m + x.complianceViolations, 0),
    0,
  );

  const customStrategyIds = [...new Set(scenarios.flatMap((s) => s.strategies.map((x) => x.strategyId)))].filter(
    (id) => id.startsWith('agent-'),
  );
  const combinedCustomWins = customStrategyIds.reduce((n, id) => n + winsById(id), 0);

  console.log('=== Overall ===');
  for (const id of customStrategyIds) {
    const wins = winsById(id);
    const name = scenarios[0]?.strategies.find((x) => x.strategyId === id)?.strategyName ?? id;
    console.log(
      `${name} posted the highest net value in ${wins} of ${totalRuns} independent cohorts` +
        ` (${((wins / totalRuns) * 100).toFixed(1)}%)`,
    );
  }
  if (customStrategyIds.length > 1) {
    console.log(
      `Combined (either of our own strategies beat every baseline): ${combinedCustomWins} of ${totalRuns}` +
        ` (${((combinedCustomWins / totalRuns) * 100).toFixed(1)}%)`,
    );
  }
  console.log(`Compliance violations across every strategy and every run: ${totalViolations}`);

  for (const id of customStrategyIds) {
    const name = scenarios[0]?.strategies.find((x) => x.strategyId === id)?.strategyName ?? id;
    const losses = scenarios.filter((s) => {
      const strat = s.strategies.find((x) => x.strategyId === id);
      return strat ? strat.wins < strat.runs : false;
    });
    if (losses.length > 0) {
      console.log(`\n${name} did not win every run:`);
      for (const s of losses) {
        const strat = s.strategies.find((x) => x.strategyId === id)!;
        console.log(`  ${s.scenarioName}: won ${strat.wins}/${strat.runs}`);
      }
    }
  }

  await mkdir('out', { recursive: true });
  const path = join('out', 'robustness.json');
  await writeFile(
    path,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        seeds,
        cohortSize: COHORT_SIZE,
        totalRuns,
        customStrategyWins: Object.fromEntries(customStrategyIds.map((id) => [id, winsById(id)])),
        combinedCustomWins,
        totalViolations,
        scenarios,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`\nWrote ${path} in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

await main();
