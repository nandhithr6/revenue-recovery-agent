import type { Paise } from '../domain/types.js';
import { SPAM_POINT_PRICE_PAISE } from '../policies/playbook.js';
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

  /**
   * Customer-annoyance score: email 1, SMS/WhatsApp 5, voice 10, silent retry 0.
   *
   * The metric that actually constrains a recovery agent. Rupee cost cannot: at
   * a median ticket of a few hundred rupees against per-message costs in paise,
   * recovery dwarfs spend by two orders of magnitude, so no honest cost model
   * makes aggression unprofitable. Irritating the merchant's customers is the
   * real price, and it is not denominated in rupees.
   */
  readonly spamPoints: number;
  /** Annoyance per rupee recovered. Lower is better. */
  readonly spamPerLakhRecovered: number;
  /**
   * Net value with annoyance priced in: recovered - spend - (spam x Rs 20).
   *
   * The single honest number. Reporting rupees and annoyance in separate
   * columns invites the reader to pick whichever favours their conclusion; this
   * forces the trade to be made explicitly, at a stated exchange rate.
   */
  readonly netValueAfterAnnoyancePaise: Paise;

  /**
   * Actions the guardrails refused. This is NOT a failure count: it is evidence
   * the guardrails are load-bearing. A strategy with zero blocks either never
   * pushed hard enough to hit a limit, or is not going through the gate.
   */
  readonly blockedActions: number;
  /** Actions postponed to a compliant window instead of being dropped. */
  readonly deferrals: number;
  /** Network fees and auth-rate damage incurred by retrying hard declines. */
  readonly issuerPenaltyPaise: Paise;
  /** Which guardrail rules fired, and how often. */
  readonly ruleTally: Readonly<Record<string, number>>;

  /**
   * Compliance breaches that actually executed. Must be zero by construction:
   * nothing reaches execution without an `allow` verdict. Reported so the claim
   * is measured rather than asserted.
   */
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
  let spamPoints = 0;
  let blockedActions = 0;
  let deferrals = 0;
  let issuerPenaltyPaise = 0;

  for (const c of run.cases) {
    atRiskPaise += c.amountPaise;
    recoveredPaise += c.recoveredPaise;
    costPaise += c.costPaise;
    if (c.recovered) casesRecovered += 1;
    totalRetries += c.retries;
    totalContacts += c.contacts;
    totalHumanEscalations += c.humanEscalations;
    spamPoints += c.spamPoints;
    blockedActions += c.blockedActions;
    deferrals += c.deferrals;
    issuerPenaltyPaise += c.issuerPenaltyPaise;
  }

  // Every executed contact carried an `allow` verdict, so a violation here would
  // mean the gate was bypassed. Counted rather than assumed.
  const complianceViolations = run.ledger
    .all()
    .filter((e) => e.outcome === 'executed' && e.rule !== undefined).length;

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
    spamPoints,
    spamPerLakhRecovered:
      recoveredPaise === 0 ? 0 : spamPoints / (recoveredPaise / 10_000_000),
    netValueAfterAnnoyancePaise:
      recoveredPaise - costPaise - spamPoints * SPAM_POINT_PRICE_PAISE,
    blockedActions,
    deferrals,
    issuerPenaltyPaise,
    ruleTally: run.ledger.ruleTally(),
    complianceViolations,
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
