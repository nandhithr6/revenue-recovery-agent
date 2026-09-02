import type { Paise } from '../domain/types.js';
import type { RunResult } from './engine.js';

/**
 * Scoring. The headline is net value, not gross recovery: any policy can recover
 * more by spending more, and a recovery system that costs more than it retrieves
 * is a loss dressed up as a win.
 */
export interface Metrics {
  readonly strategyId: string;
  readonly strategyName: string;

  readonly casesTotal: number;
  readonly casesRecovered: number;
  /** Share of cases recovered, 0..1. */
  readonly recoveryRate: number;

  readonly atRiskPaise: Paise;
  readonly recoveredPaise: Paise;
  readonly costPaise: Paise;
  /** recovered - cost. The number that decides the winner. */
  readonly netValuePaise: Paise;
  /** Share of at-risk money recovered, 0..1. */
  readonly recoveryRateByValue: number;

  readonly totalRetries: number;
  readonly totalContacts: number;
  readonly totalHumanEscalations: number;

  /** Efficiency: how many retries did each recovery cost? Infinity if none recovered. */
  readonly retriesPerRecovery: number;
  /** Annoyance: how many times did we bother a customer per recovery? */
  readonly contactsPerRecovery: number;

  /** Rupees returned per rupee spent. Infinity when nothing was spent. */
  readonly returnOnSpend: number;

  /** Guardrail breaches. Must be zero. Populated once guardrails land. */
  readonly complianceViolations: number;
}

export function score(run: RunResult): Metrics {
  let atRiskPaise = 0;
  let recoveredPaise = 0;
  let costPaise = 0;
  let casesRecovered = 0;
  let totalRetries = 0;
  let totalContacts = 0;
  let totalHumanEscalations = 0;

  for (const c of run.cases) {
    atRiskPaise += c.amountPaise;
    recoveredPaise += c.recoveredPaise;
    costPaise += c.costPaise;
    if (c.recovered) casesRecovered += 1;
    totalRetries += c.retries;
    totalContacts += c.contacts;
    totalHumanEscalations += c.humanEscalations;
  }

  const casesTotal = run.cases.length;
  const safeRate = (n: number, d: number): number => (d === 0 ? 0 : n / d);
  const perRecovery = (n: number): number =>
    casesRecovered === 0 ? Number.POSITIVE_INFINITY : n / casesRecovered;

  return {
    strategyId: run.strategyId,
    strategyName: run.strategyName,
    casesTotal,
    casesRecovered,
    recoveryRate: safeRate(casesRecovered, casesTotal),
    atRiskPaise,
    recoveredPaise,
    costPaise,
    netValuePaise: recoveredPaise - costPaise,
    recoveryRateByValue: safeRate(recoveredPaise, atRiskPaise),
    totalRetries,
    totalContacts,
    totalHumanEscalations,
    retriesPerRecovery: perRecovery(totalRetries),
    contactsPerRecovery: perRecovery(totalContacts),
    returnOnSpend:
      costPaise === 0 ? Number.POSITIVE_INFINITY : recoveredPaise / costPaise,
    complianceViolations: 0,
  };
}

/**
 * Per-recovery-class breakdown. This is where a reason-aware policy visibly
 * differs from a reason-blind one: same headline, very different distribution
 * of where the effort went.
 */
export interface ClassBreakdown {
  readonly recoveryClass: string;
  readonly cases: number;
  readonly recovered: number;
  readonly recoveryRate: number;
  readonly retries: number;
  readonly costPaise: Paise;
  readonly recoveredPaise: Paise;
  readonly netValuePaise: Paise;
}

export function breakdownByClass(run: RunResult): ClassBreakdown[] {
  const acc = new Map<
    string,
    { cases: number; recovered: number; retries: number; cost: number; got: number }
  >();

  for (const c of run.cases) {
    const key = c.recoveryClass;
    const row = acc.get(key) ?? { cases: 0, recovered: 0, retries: 0, cost: 0, got: 0 };
    row.cases += 1;
    if (c.recovered) row.recovered += 1;
    row.retries += c.retries;
    row.cost += c.costPaise;
    row.got += c.recoveredPaise;
    acc.set(key, row);
  }

  return [...acc.entries()]
    .map(([recoveryClass, r]) => ({
      recoveryClass,
      cases: r.cases,
      recovered: r.recovered,
      recoveryRate: r.cases === 0 ? 0 : r.recovered / r.cases,
      retries: r.retries,
      costPaise: r.cost,
      recoveredPaise: r.got,
      netValuePaise: r.got - r.cost,
    }))
    .sort((a, b) => b.netValuePaise - a.netValuePaise);
}
