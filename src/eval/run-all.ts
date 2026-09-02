import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BASELINE_STRATEGIES } from '../policies/baselines.js';
import { createRulesAgent } from '../policies/rules-agent.js';
import { LOSS_PROFILES } from '../policies/loss-profiles.js';
import { PLAYBOOKS } from '../policies/playbook.js';
import type { Strategy } from '../policies/types.js';
import { generateCohort, summariseCohort } from '../sim/generator.js';
import { DEFAULT_COSTS, SCENARIO_IDS, getScenario } from '../sim/scenario.js';
import { runCohort } from './engine.js';
import { breakdownByClass, score } from './metrics.js';

/**
 * `npm run eval:all` — runs every strategy against every scenario and writes a
 * single bundle the dashboard reads.
 *
 * Deliberately one file: the dashboard should never have to know how to run the
 * simulation, and the pitch video should never contain a number that was not
 * produced by this script.
 */

const SIMULATION_START = Date.parse('2026-09-01T00:00:00+05:30');

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
    };
  });

  const bundle = {
    generatedAt: new Date().toISOString(),
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
  await writeFile(path, JSON.stringify(bundle, null, 2), 'utf8');

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
