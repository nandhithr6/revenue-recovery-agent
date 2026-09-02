/** Shapes of the bundle written by `npm run eval:all`. */

export interface Metrics {
  strategyId: string;
  strategyName: string;
  casesTotal: number;
  casesRecovered: number;
  recoveryRate: number;
  atRiskPaise: number;
  recoveredPaise: number;
  costPaise: number;
  netValuePaise: number;
  recoveryRateByValue: number;
  totalRetries: number;
  totalContacts: number;
  totalHumanEscalations: number;
  retriesPerRecovery: number;
  contactsPerRecovery: number;
  returnOnSpend: number;
  spamPoints: number;
  spamPerLakhRecovered: number;
  netValueAfterAnnoyancePaise: number;
  blockedActions: number;
  deferrals: number;
  issuerPenaltyPaise: number;
  ruleTally: Record<string, number>;
  complianceViolations: number;
}

export interface ClassBreakdown {
  recoveryClass: string;
  cases: number;
  recovered: number;
  recoveryRate: number;
  retries: number;
  costPaise: number;
  recoveredPaise: number;
  netValuePaise: number;
}

export interface StrategyResult {
  id: string;
  name: string;
  description: string;
  metrics: Metrics;
  byClass: ClassBreakdown[];
}

export interface LedgerEntry {
  seq: number;
  caseId: string;
  at: number;
  actionKind: string;
  channel?: string;
  outcome: 'executed' | 'deferred' | 'blocked' | 'stopped';
  succeeded?: boolean;
  rationale: string;
  rule?: string;
  explanation?: string;
  deferredTo?: number;
  costPaise: number;
  spamPoints: number;
}

export interface ScenarioResult {
  id: string;
  name: string;
  description: string;
  seed: number;
  cohort: {
    count: number;
    totalAtRiskPaise: number;
    byRecoveryClass: Record<string, number>;
    byLossType: Record<string, number>;
    byMethod: Record<string, number>;
  };
  strategies: StrategyResult[];
  ruleTally: Record<string, number>;
  sampleAuditTrail: LedgerEntry[];
}

export interface LossProfileView {
  label: string;
  canRetryCharge: boolean;
  tracksPromiseToPay: boolean;
  reasoning: string;
}

export interface Bundle {
  generatedAt: string;
  costModel: Record<string, unknown>;
  playbooks: Record<
    string,
    {
      retryOffsetsHours: number[];
      channelLadder: string[];
      nudgeIsThePath: boolean;
      reasoning: string;
    }
  >;
  lossProfiles: Record<string, LossProfileView>;
  scenarios: ScenarioResult[];
}
