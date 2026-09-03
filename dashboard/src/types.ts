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

export interface AgentView {
  reasonCode?: string;
  derivedRecoveryClass: string;
  lossType: string;
  method: string;
  amountPaise: number;
  hoursSinceFailure: number;
  retriesSoFar: number;
  contactsSoFar: number;
  channelsUsed: string[];
  consentedChannels: string[];
  dndRegistered: boolean;
  rulesAlreadyHit: string[];
}

export interface TraceStep {
  step: number;
  at: number;
  seen: AgentView;
  decided: { kind: string; channel?: string; delayMs: number; rationale: string };
  verdict: { kind: 'allow' | 'defer' | 'block'; rule?: string; explanation?: string; notBefore?: number };
  outcome: 'executed' | 'deferred' | 'blocked' | 'stopped';
  succeeded?: boolean;
  costPaise: number;
  spamPoints: number;
}

export interface CaseTrace {
  strategyId: string;
  steps: TraceStep[];
  recovered: boolean;
  recoveredPaise: number;
  costPaise: number;
  spamPoints: number;
  stoppedReason: string;
}

export interface InspectableCase {
  event: {
    id: string;
    amountPaise: number;
    method: string;
    lossType: string;
    reasonCode?: string;
    recoveryClass: string;
    occurredAt: number;
    customer: { id: string; dndRegistered: boolean; consent: Record<string, boolean> };
  };
  traces: CaseTrace[];
}

export interface LiveFeedEntry {
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
  amountPaise: number;
  reasonCode?: string;
  recoveryClass: string;
  lossType: string;
  isRecoveryMoment: boolean;
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
  inspectableCases: InspectableCase[];
  liveFeed: LiveFeedEntry[];
}

export interface LossProfileView {
  label: string;
  canRetryCharge: boolean;
  tracksPromiseToPay: boolean;
  reasoning: string;
}

export interface Robustness {
  seeds: number;
  cohortSize: number;
  totalRuns: number;
  agentWins: number;
  totalViolations: number;
  scenarios: {
    scenarioId: string;
    scenarioName: string;
    seeds: number;
    strategies: {
      strategyId: string;
      strategyName: string;
      netValue: { mean: number; p10: number; p90: number; stdDev: number };
      wins: number;
      runs: number;
    }[];
  }[];
}

export interface Sensitivity {
  shippedPricePaise: number;
  pricesPaise: number[];
  seeds: number;
  adaptiveRankingStable: boolean;
  scenarios: {
    scenarioId: string;
    scenarioName: string;
    adaptive: {
      points: { pricePaise: number; byStrategy: Record<string, number>; winnerName: string }[];
      flipped: boolean;
    };
  }[];
}

export interface LiveRun {
  generatedAt: string;
  note: string;
  cases: {
    caseId: string;
    reasonCode: string;
    recoveryClass: string;
    amountPaise: number;
    orderId: string;
    testCardToReproduce: string | null;
    actions: {
      step: number;
      decided: string;
      channel?: string;
      rationale: string;
      verdict: string;
      rule?: string;
      razorpay?: Record<string, string>;
    }[];
  }[];
}

export interface LiveDecline {
  generatedAt: string;
  paymentLinkId: string;
  razorpayError: Record<string, string | null>;
  taxonomyRecognised: boolean;
  recoveryClass: string | null;
  agentDecisions: { step: number; kind: string; rationale: string; verdict?: string }[];
}

export interface Bundle {
  generatedAt: string;
  robustness: Robustness | null;
  sensitivity: Sensitivity | null;
  liveRun: LiveRun | null;
  liveDecline: LiveDecline | null;
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
