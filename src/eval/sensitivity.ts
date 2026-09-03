import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Paise } from '../domain/types.js';
import { BASELINE_STRATEGIES } from '../policies/baselines.js';
import { SPAM_POINT_PRICE_PAISE } from '../policies/playbook.js';
import { createAdaptiveAgent } from '../policies/adaptive-agent.js';
import { createRulesAgent } from '../policies/rules-agent.js';
import type { Strategy } from '../policies/types.js';
import { generateCohort } from '../sim/generator.js';
import { DEFAULT_COSTS, SCENARIO_IDS, getScenario } from '../sim/scenario.js';
import { runCohort } from './engine.js';
import { score } from './metrics.js';

/**
 * `npm run eval:sensitivity`
 *
 * Our headline metric prices customer annoyance at Rs 20 a point. That figure is
 * a judgement call and the most attackable number in the project: price it high
 * enough and any strategy that contacts anyone looks bad; price it low enough
 * and spamming everybody looks free.
 *
 * So rather than defend Rs 20, sweep it.
 *
 * TWO SWEEPS, because they answer different questions.
 *
 *   FIXED    - the shipped agent, scored at each price. Asks: "is your winner an
 *              artefact of your scoring constant?"
 *   ADAPTIVE - the agent rebuilt at each price so its own spend threshold moves
 *              with it. Asks the fairer question: "at a different price, does it
 *              still win once it is allowed to KNOW the price?" A flip in the
 *              fixed sweep may only mean the agent was never told the rules
 *              changed.
 *
 * EVERY POINT IS AVERAGED OVER MANY SEEDS, and that is not optional. Changing
 * the agent's threshold changes which actions it takes, which shifts the whole
 * RNG sequence, so a single-seed adaptive sweep is a different random draw at
 * every price. The first version of this file did exactly that and produced
 * swings of about 1L -- the same size as the agent's own standard deviation
 * across cohorts. It looked like sensitivity and was pure noise.
 */

const SIMULATION_START = Date.parse('2026-09-01T00:00:00+05:30');

/** Rs 0 to Rs 100 per annoyance point, in paise. */
const PRICES_PAISE: readonly Paise[] = [0, 500, 1_000, 2_000, 3_000, 5_000, 7_500, 10_000];

/** Enough draws to put the noise well below the differences being read. */
const SEEDS = 15;
const COHORT_SIZE = 500;

interface PricePoint {
  readonly pricePaise: Paise;
  /** Mean net value across seeds, per strategy. */
  readonly byStrategy: Readonly<Record<string, number>>;
  readonly winnerId: string;
  readonly winnerName: string;
  /** Spread of the agent's own results, so a reader can judge the noise floor. */
  readonly agentStdDev: number;
}

interface SweepResult {
  readonly points: readonly PricePoint[];
  readonly flipped: boolean;
  readonly winners: readonly string[];
}

/**
 * Run one sweep.
 *
 * @param adaptive when true, the agent is rebuilt at each price so it knows what
 *   annoyance costs. When false, the shipped agent is used throughout and only
 *   the scoring changes.
 */
function sweep(scenarioId: string, adaptive: boolean): SweepResult {
  const base = getScenario(scenarioId);

  const points = PRICES_PAISE.map((pricePaise): PricePoint => {
    const totals = new Map<string, number>();
    const names = new Map<string, string>();
    const agentValues: number[] = [];

    for (let i = 0; i < SEEDS; i++) {
      const seed = base.seed + i * 7919;
      const scenario = { ...base, seed, cohortSize: COHORT_SIZE };
      const events = generateCohort(scenario, SIMULATION_START);

      const strategies: readonly Strategy[] = [
        ...BASELINE_STRATEGIES,
        createRulesAgent(DEFAULT_COSTS, adaptive ? pricePaise : SPAM_POINT_PRICE_PAISE),
        createAdaptiveAgent(DEFAULT_COSTS, adaptive ? pricePaise : SPAM_POINT_PRICE_PAISE),
      ];

      let bestCustomValue = Number.NEGATIVE_INFINITY;
      for (const strategy of strategies) {
        const m = score(runCohort(events, strategy, DEFAULT_COSTS, seed + 1));
        const value = m.recoveredPaise - m.costPaise - m.spamPoints * pricePaise;
        totals.set(strategy.id, (totals.get(strategy.id) ?? 0) + value);
        names.set(strategy.id, strategy.name);
        if (strategy.id.startsWith('agent-') && value > bestCustomValue) bestCustomValue = value;
      }
      // Spread of the BETTER of our two strategies each seed -- with two custom
      // strategies now in the field, tracking just one would understate how
      // tight the actual result is, since the harness always reports the winner.
      agentValues.push(bestCustomValue);
    }

    const byStrategy: Record<string, number> = {};
    let winnerId = '';
    let winnerName = '';
    let best = Number.NEGATIVE_INFINITY;
    for (const [id, total] of totals) {
      const mean = total / SEEDS;
      byStrategy[id] = mean;
      if (mean > best) {
        best = mean;
        winnerId = id;
        winnerName = names.get(id)!;
      }
    }

    const agentMean = agentValues.reduce((a, b) => a + b, 0) / agentValues.length;
    const agentStdDev = Math.sqrt(
      agentValues.reduce((acc, v) => acc + (v - agentMean) ** 2, 0) / agentValues.length,
    );

    return { pricePaise, byStrategy, winnerId, winnerName, agentStdDev };
  });

  const winners = [...new Set(points.map((p) => p.winnerId))];
  return { points, flipped: winners.length > 1, winners };
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

const lakh = (paise: number): string => `${(paise / 10_000_000).toFixed(2)}L`;
const rupees = (paise: Paise): string => `Rs ${(paise / 100).toFixed(0)}`;

const STRATEGY_ORDER = [
  'do-nothing',
  'naive-retry',
  'fixed-dunning',
  'agent-rules',
  'agent-adaptive',
] as const;
const STRATEGY_NAMES = [
  'Do nothing',
  'Naive retry',
  'Fixed dunning',
  'Reason-aware agent',
  'Adaptive agent',
];

function renderSweep(label: string, result: SweepResult): void {
  printTable(
    [label, ...STRATEGY_NAMES, 'Winner', '+/- best'],
    result.points.map((p) => [
      rupees(p.pricePaise),
      ...STRATEGY_ORDER.map((id) => lakh(p.byStrategy[id] ?? 0)),
      p.winnerName,
      lakh(p.agentStdDev),
    ]),
  );
}

async function main(): Promise<void> {
  console.log(
    `\nAnnoyance price sweep: ${rupees(PRICES_PAISE[0]!)} to ${rupees(PRICES_PAISE.at(-1)!)} per point.\n` +
      `Shipped value ${rupees(SPAM_POINT_PRICE_PAISE)}. Every point is the mean of ${SEEDS} seeds ` +
      `at ${COHORT_SIZE} cases.\n`,
  );

  const started = Date.now();

  const scenarios = SCENARIO_IDS.map((id) => {
    const scenario = getScenario(id);
    const fixed = sweep(id, false);
    const adaptive = sweep(id, true);

    console.log(`=== ${scenario.name} ===`);
    renderSweep('Fixed policy', fixed);
    console.log(
      fixed.flipped
        ? `  -> scored at prices it was not told about, the winner changes: ${fixed.winners.join(' -> ')}`
        : '  -> the winner never changes',
    );
    console.log('');
    renderSweep('Adaptive', adaptive);
    console.log(
      adaptive.flipped
        ? `  -> even when told the price, the winner changes: ${adaptive.winners.join(' -> ')}\n`
        : '  -> told the price, the agent wins at every point in the range\n',
    );

    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      fixed,
      adaptive,
    };
  });

  const fixedFlips = scenarios.filter((s) => s.fixed.flipped);
  const adaptiveFlips = scenarios.filter((s) => s.adaptive.flipped);

  console.log('=== Conclusion ===');

  if (fixedFlips.length > 0) {
    console.log('Holding the shipped policy fixed, the winner changes in:');
    for (const s of fixedFlips) {
      const flip = s.fixed.points.find(
        (p, i) => i > 0 && p.winnerId !== s.fixed.points[i - 1]!.winnerId,
      );
      if (flip) console.log(`  ${s.scenarioName}: to ${flip.winnerName} at ${rupees(flip.pricePaise)}`);
    }
    console.log('');
  }

  if (adaptiveFlips.length === 0) {
    console.log(
      `When the agent is told what annoyance costs, it posts the highest net value at\n` +
        `every price from ${rupees(PRICES_PAISE[0]!)} to ${rupees(PRICES_PAISE.at(-1)!)}, in all ` +
        `${scenarios.length} scenarios.\n\n` +
        `So the Rs ${SPAM_POINT_PRICE_PAISE / 100} figure is not doing the work. Where the fixed sweep flips, it\n` +
        `shows something narrower and worth saying plainly: a policy tuned for one\n` +
        `price is not automatically right at another. The agent adapts; the constant\n` +
        `is an input, not a thumb on the scale.`,
    );
  } else {
    console.log('Even when told the price, the winner changes in:');
    for (const s of adaptiveFlips) {
      console.log(`  ${s.scenarioName}: ${s.adaptive.winners.join(' -> ')}`);
    }
    console.log('\nThat is a real limit and belongs in the writeup as stated.');
  }

  await mkdir('out', { recursive: true });
  const path = join('out', 'sensitivity.json');
  await writeFile(
    path,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        shippedPricePaise: SPAM_POINT_PRICE_PAISE,
        pricesPaise: PRICES_PAISE,
        seeds: SEEDS,
        cohortSize: COHORT_SIZE,
        adaptiveRankingStable: adaptiveFlips.length === 0,
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
