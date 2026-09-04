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

export interface CaseAssessment {
  status: 'known' | 'inferred' | 'unknown';
  recoveryClass?: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  anomalies: string[];
}

export interface CustomerSignal {
  kind: 'promise_to_pay' | 'funds_available_now' | 'instrument_fixed' | 'disputes_charge' | 'refused' | 'no_answer';
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
  assessment: CaseAssessment;
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
  signal?: CustomerSignal;
  candidates?: CandidateSummary[];
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
    debitStatus: string;
    customer: { id: string; dndRegistered: boolean; consent: Record<string, boolean> };
  };
  traces: CaseTrace[];
}

export interface CandidateSummary {
  kind: string;
  channel?: string;
  grossRecoveryPaise: number;
  costPaise: number;
  spamPoints: number;
  expectedValuePaise: number;
  dominated?: boolean;
  chosen: boolean;
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
  method: string;
  reasonCode?: string;
  recoveryClass: string;
  lossType: string;
  isRecoveryMoment: boolean;
  signal?: CustomerSignal;
  /** The priced candidate comparison behind this decision -- see `eval/run-all.ts:candidateHook`. Absent for a short-circuited decision (a terminal rule, a voice-signal reaction, a promise window). */
  candidates?: CandidateSummary[];
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
  outcomeAudit: OutcomeAudit;
}

export interface NonRecoveredCase {
  eventId: string;
  amountPaise: number;
  recoveryClass: string;
  stoppedReason: string;
  category: string;
  note: string;
  missedAction?: string;
  missedRealEvPaise?: number;
}

export interface OutcomeCategorySummary {
  category: string;
  label: string;
  count: number;
  atRiskPaise: number;
  byClass: Record<string, number>;
  examples: NonRecoveredCase[];
}

export interface OutcomeAudit {
  totalCases: number;
  recoveredCases: number;
  recoveryRate: number;
  nonRecoveredCases: number;
  nonRecoveredAtRiskPaise: number;
  categories: OutcomeCategorySummary[];
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
  customStrategyWins: Record<string, number>;
  combinedCustomWins: number;
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

/**
 * NOVELTY / SAFETY ROBUSTNESS -- explicitly not the financial benchmark.
 * Measures safe behaviour on hand-authored adversarial cases, never
 * recovered revenue. See `eval/novelty.ts`.
 */
export interface Novelty {
  generatedAt: string;
  label: string;
  totalCases: number;
  safe: number;
  unsafe: number;
  complianceViolations: number;
  guardrailBlocks: number;
  results: {
    id: string;
    category: string;
    description: string;
    safe: boolean;
    detail: string;
  }[];
}

export interface VoiceShowcase {
  scenarioId: string;
  scenarioName: string;
  event: InspectableCase['event'];
  trace: CaseTrace;
  source: 'naturally-occurring' | 'constructed-fixture';
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
  novelty: Novelty | null;
  voiceShowcase: VoiceShowcase | null;
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
