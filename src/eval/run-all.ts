import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BASELINE_STRATEGIES } from '../policies/baselines.js';
import { createRulesAgent } from '../policies/rules-agent.js';
import { LOSS_PROFILES } from '../policies/loss-profiles.js';
import { PLAYBOOKS } from '../policies/playbook.js';
import type { Strategy } from '../policies/types.js';
import { generateCohort, summariseCohort } from '../sim/generator.js';
import { DEFAULT_COSTS, SCENARIO_IDS, getScenario } from '../sim/scenario.js';
import { runCase, runCohort } from './engine.js';
import { breakdownByClass, score } from './metrics.js';
import { TraceSink, type CaseTrace } from './trace.js';
import { Ledger } from '../ledger/ledger.js';
import { Rng } from '../sim/rng.js';
import { lookupReason } from '../domain/failure-taxonomy.js';
import type { LossEvent } from '../domain/types.js';

/**
 * `npm run eval:all` — runs every strategy against every scenario and writes a
 * single bundle the dashboard reads.
 *
 * Deliberately one file: the dashboard should never have to know how to run the
 * simulation, and the pitch video should never contain a number that was not
 * produced by this script.
 */

const SIMULATION_START = Date.parse('2026-09-01T00:00:00+05:30');

/** How many cases get a full per-strategy trace exported. */
const INSPECTABLE_PER_CLASS = 6;

interface InspectableCase {
  readonly event: {
    readonly id: string;
    readonly amountPaise: number;
    readonly method: string;
    readonly lossType: string;
    readonly reasonCode: string | undefined;
    readonly recoveryClass: string;
    readonly occurredAt: number;
    readonly customer: {
      readonly id: string;
      readonly dndRegistered: boolean;
      readonly consent: Readonly<Record<string, boolean>>;
    };
  };
  readonly traces: readonly CaseTrace[];
}

/**
 * Export full decision traces for a curated subset of cases.
 *
 * Curated, not random. The point of these is to let a reader verify the system
 * rather than take the scoreboard on trust, so the sample is chosen to cover
 * every recovery class and to favour the cases where the strategies actually
 * disagree — those are the ones that show what reason-awareness buys.
 */
function buildInspectableCases(
  events: readonly LossEvent[],
  strategies: readonly Strategy[],
  seed: number,
): InspectableCase[] {
  const scored = events.map((event) => {
    const traces: CaseTrace[] = strategies.map((strategy) => {
      const sink = new TraceSink();
      // A fresh RNG per case per strategy: identical randomness for each
      // strategy on the same case, so a side-by-side comparison differs only by
      // the decisions taken. The cohort runs use a shared stream instead, which
      // is right for aggregates and wrong for a one-case comparison.
      const rng = new Rng(seed + hashId(event.id));
      const result = runCase(event, strategy, DEFAULT_COSTS, rng, new Ledger(), undefined, sink);
      return {
        strategyId: strategy.id,
        steps: sink.drain(),
        recovered: result.recovered,
        recoveredPaise: result.recoveredPaise,
        costPaise: result.costPaise,
        spamPoints: result.spamPoints,
        stoppedReason: result.stoppedReason,
      };
    });

    // Interesting = the strategies disagreed about the outcome, or a guardrail
    // visibly intervened. A case every strategy handles identically teaches a
    // reader nothing.
    const outcomes = new Set(traces.map((t) => t.recovered));
    const intervened = traces.some((t) =>
      t.steps.some((s) => s.outcome === 'deferred' || s.outcome === 'blocked'),
    );
    const interest = (outcomes.size > 1 ? 2 : 0) + (intervened ? 1 : 0);

    return { event, traces, interest };
  });

  const byClass = new Map<string, typeof scored>();
  for (const row of scored) {
    const cls = row.event.reasonCode
      ? (lookupReason(row.event.reasonCode)?.recoveryClass ?? 'UNKNOWN')
      : 'UNKNOWN';
    const bucket = byClass.get(cls) ?? [];
    bucket.push(row);
    byClass.set(cls, bucket);
  }

  const picked: InspectableCase[] = [];
  for (const [cls, bucket] of byClass) {
    bucket
      .sort((a, b) => b.interest - a.interest || b.event.amountPaise - a.event.amountPaise)
      .slice(0, INSPECTABLE_PER_CLASS)
      .forEach((row) => {
        picked.push({
          event: {
            id: row.event.id,
            amountPaise: row.event.amountPaise,
            method: row.event.method,
            lossType: row.event.lossType,
            reasonCode: row.event.reasonCode,
            recoveryClass: cls,
            occurredAt: row.event.occurredAt,
            customer: {
              id: row.event.customer.id,
              dndRegistered: row.event.customer.dndRegistered,
              consent: row.event.customer.consent,
            },
          },
          traces: row.traces,
        });
      });
  }

  return picked;
}

/** Stable small integer from a case id, so per-case RNG seeds are reproducible. */
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 100_000;
}

async function main(): Promise<void> {
  const strategies: readonly Strategy[] = [
    ...BASELINE_STRATEGIES,
    createRulesAgent(DEFAULT_COSTS),
  ];

  const scenarios = SCENARIO_IDS.map((id) => {
    const scenario = getScenario(id);
    const events = generateCohort(scenario, SIMULATION_START);
    const summary = summariseCohort(events);

    const runs = strategies.map((s) => runCohort(events, s, DEFAULT_COSTS, scenario.seed + 1));
    const results = runs.map(score);

    const agentRun = runs.find((r) => r.strategyId === 'agent-rules')!;

    // Pick the case that best demonstrates the system rather than the first one
    // to hand: it must show a guardrail intervening, and among those we take the
    // longest trail, so the reader sees a decision, a refusal, a reschedule and
    // an outcome rather than a fragment.
    const byCase = new Map<string, number>();
    for (const e of agentRun.ledger.all()) {
      byCase.set(e.caseId, (byCase.get(e.caseId) ?? 0) + 1);
    }
    const interesting = new Set(
      agentRun.ledger
        .all()
        .filter((e) => e.outcome === 'deferred' || e.outcome === 'blocked')
        .map((e) => e.caseId),
    );
    const sampleCaseId =
      [...interesting].sort((a, b) => (byCase.get(b) ?? 0) - (byCase.get(a) ?? 0))[0] ??
      agentRun.ledger.all()[0]?.caseId;

    return {
      id: scenario.id,
      name: scenario.name,
      description: scenario.description,
      seed: scenario.seed,
      cohort: {
        count: summary.count,
        totalAtRiskPaise: summary.totalAtRiskPaise,
        byRecoveryClass: summary.byRecoveryClass,
        byLossType: summary.byLossType,
        byMethod: summary.byMethod,
      },
      strategies: runs.map((run, i) => ({
        id: run.strategyId,
        name: run.strategyName,
        description: strategies[i]!.description,
        metrics: results[i]!,
        byClass: breakdownByClass(run),
      })),
      ruleTally: agentRun.ledger.ruleTally(),
      sampleAuditTrail: sampleCaseId ? agentRun.ledger.forCase(sampleCaseId) : [],
      inspectableCases: buildInspectableCases(events, strategies, scenario.seed + 1),
    };
  });

  // Fold in whatever the other runs have produced. Each is optional: the
  // dashboard degrades to 'not run yet' rather than failing, so a fresh clone
  // that has only run eval:all still renders.
  const optional = async (file: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(join('out', file), 'utf8'));
    } catch {
      return null;
    }
  };

  const [robustness, sensitivity, liveRun, liveDecline] = await Promise.all([
    optional('robustness.json'),
    optional('sensitivity.json'),
    optional('live-run.json'),
    optional('live-decline.json'),
  ]);

  const bundle = {
    generatedAt: new Date().toISOString(),
    robustness,
    sensitivity,
    liveRun,
    liveDecline,
    costModel: DEFAULT_COSTS,
    playbooks: Object.fromEntries(
      Object.entries(PLAYBOOKS).map(([k, p]) => [
        k,
        {
          retryOffsetsHours: p.retrySchedule.map((d) => d / 3_600_000),
          channelLadder: p.channelLadder,
          nudgeIsThePath: p.nudgeIsThePath,
          reasoning: p.reasoning,
        },
      ]),
    ),
    lossProfiles: Object.fromEntries(
      Object.entries(LOSS_PROFILES).map(([k, p]) => [
        k,
        {
          label: p.label,
          canRetryCharge: p.canRetryCharge,
          tracksPromiseToPay: p.tracksPromiseToPay,
          reasoning: p.reasoning,
        },
      ]),
    ),
    scenarios,
  };

  await mkdir('out', { recursive: true });
  const path = join('out', 'all-results.json');
  // Compact, not pretty-printed: indentation roughly doubles the size and the
  // dashboard fetches this on load. Readable with `jq .` when a human wants it.
  await writeFile(path, JSON.stringify(bundle), 'utf8');

  const agent = scenarios.map((s) => s.strategies.find((x) => x.id === 'agent-rules')!);
  const wins = scenarios.filter((s) => {
    const a = s.strategies.find((x) => x.id === 'agent-rules')!.metrics
      .netValueAfterAnnoyancePaise;
    return s.strategies.every(
      (x) => x.id === 'agent-rules' || x.metrics.netValueAfterAnnoyancePaise <= a,
    );
  }).length;

  console.log(`Wrote ${path}`);
  console.log(`  ${scenarios.length} scenarios x ${strategies.length} strategies`);
  console.log(`  agent best on ${wins}/${scenarios.length}`);
  console.log(
    `  total compliance violations: ${agent.reduce((n, a) => n + a.metrics.complianceViolations, 0)}`,
  );
}

await main();
