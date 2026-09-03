import { describe, expect, it } from 'vitest';
import { createAdaptiveAgent } from '../policies/adaptive-agent.js';
import { generateCohort } from '../sim/generator.js';
import { DEFAULT_COSTS, getScenario } from '../sim/scenario.js';
import { auditOutcomes } from './outcome-audit.js';

const SIMULATION_START = Date.parse('2026-09-01T00:00:00+05:30');

describe('outcome audit: read-only classification of non-recovered cases', () => {
  const scenario = getScenario('baseline-week');
  const events = generateCohort(scenario, SIMULATION_START);
  const strategy = createAdaptiveAgent(DEFAULT_COSTS);
  const audit = auditOutcomes(events, strategy, DEFAULT_COSTS, scenario.seed + 1);

  it('matches the cohort headline recovery rate exactly', () => {
    expect(audit.totalCases).toBe(500);
    expect(audit.recoveredCases + audit.nonRecoveredCases).toBe(audit.totalCases);
    expect(audit.recoveryRate).toBeCloseTo(audit.recoveredCases / audit.totalCases, 10);
  });

  it('every category count and ₹-at-risk sums to the non-recovered totals -- no case counted twice or dropped', () => {
    const totalCount = audit.categories.reduce((s, c) => s + c.count, 0);
    const totalAtRisk = audit.categories.reduce((s, c) => s + c.atRiskPaise, 0);
    expect(totalCount).toBe(audit.nonRecoveredCases);
    expect(totalAtRisk).toBe(audit.nonRecoveredAtRiskPaise);
  });

  it('every HARD_DECLINE non-recovered case lands in hard_permanent_failure, never elsewhere', () => {
    const hardDeclineBucket = audit.categories.find((c) => c.category === 'hard_permanent_failure')!;
    const hardDeclineElsewhere = audit.categories
      .filter((c) => c.category !== 'hard_permanent_failure')
      .reduce((s, c) => s + (c.byClass.HARD_DECLINE ?? 0), 0);
    expect(hardDeclineBucket.count).toBeGreaterThan(0);
    expect(hardDeclineElsewhere).toBe(0);
  });

  it('a missed-opportunity case always names a concrete alternative action and a real EV figure', () => {
    const missed = audit.categories.find((c) => c.category === 'wrong_action_missed_opportunity')!;
    for (const ex of missed.examples) {
      expect(ex.missedAction).toBeTruthy();
      expect(ex.missedRealEvPaise).toBeGreaterThan(0);
    }
  });

  it('is deterministic: re-running the identical cohort and seed reproduces the identical breakdown', () => {
    const again = auditOutcomes(events, createAdaptiveAgent(DEFAULT_COSTS), DEFAULT_COSTS, scenario.seed + 1);
    expect(again.recoveredCases).toBe(audit.recoveredCases);
    expect(again.categories.map((c) => c.count)).toEqual(audit.categories.map((c) => c.count));
  });

  it('never changes what actually recovered relative to a plain, untraced cohort run -- this audit changes nothing about the simulation', async () => {
    const { runCohort } = await import('./engine.js');
    const plain = runCohort(events, createAdaptiveAgent(DEFAULT_COSTS), DEFAULT_COSTS, scenario.seed + 1);
    const plainRecovered = plain.cases.filter((c) => c.recovered).length;
    expect(plainRecovered).toBe(audit.recoveredCases);
  });
});
