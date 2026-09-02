import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Scenario } from '../sim/scenario.js';
import type { RunResult } from './engine.js';
import { breakdownByClass, type Metrics } from './metrics.js';

/**
 * Writes the machine-readable artefacts of a run.
 *
 * The pitch video renders from `results.json` rather than from numbers typed
 * into a slide. Re-run the eval and the video updates; there is no path by
 * which the presentation can drift from what the code actually produced.
 */

export interface ReportPayload {
  readonly generatedAt: string;
  readonly scenario: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly seed: number;
    readonly cohortSize: number;
  };
  readonly cohort: {
    readonly count: number;
    readonly totalAtRiskPaise: number;
    readonly byRecoveryClass: Record<string, number>;
  };
  readonly strategies: readonly {
    readonly id: string;
    readonly name: string;
    readonly metrics: Metrics;
    readonly byClass: ReturnType<typeof breakdownByClass>;
  }[];
  /** A single case walked end to end, for the audit-trail segment of the video. */
  readonly sampleAuditTrail: readonly unknown[];
}

export async function writeReport(
  outDir: string,
  scenario: Scenario,
  cohort: ReportPayload['cohort'],
  runs: readonly RunResult[],
  results: readonly Metrics[],
): Promise<{ resultsPath: string; ledgerPath: string }> {
  await mkdir(outDir, { recursive: true });

  const agentRun = runs.find((r) => r.strategyId.startsWith('agent')) ?? runs[runs.length - 1]!;

  // Prefer a case that shows the guardrails visibly working: an action deferred
  // to a compliant window is the single most illustrative entry we produce.
  const deferred = agentRun.ledger.deferred()[0];
  const sampleCaseId = deferred?.caseId ?? agentRun.ledger.all()[0]?.caseId;
  const sampleAuditTrail = sampleCaseId ? agentRun.ledger.forCase(sampleCaseId) : [];

  const payload: ReportPayload = {
    generatedAt: new Date().toISOString(),
    scenario: {
      id: scenario.id,
      name: scenario.name,
      description: scenario.description,
      seed: scenario.seed,
      cohortSize: scenario.cohortSize,
    },
    cohort,
    strategies: runs.map((run, i) => ({
      id: run.strategyId,
      name: run.strategyName,
      metrics: results[i]!,
      byClass: breakdownByClass(run),
    })),
    sampleAuditTrail,
  };

  const resultsPath = join(outDir, 'results.json');
  const ledgerPath = join(outDir, `ledger-${agentRun.strategyId}.jsonl`);

  await mkdir(dirname(resultsPath), { recursive: true });
  await writeFile(resultsPath, JSON.stringify(payload, null, 2), 'utf8');
  await writeFile(ledgerPath, agentRun.ledger.toJSONL(), 'utf8');

  return { resultsPath, ledgerPath };
}
