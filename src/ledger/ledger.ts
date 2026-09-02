import type { ActionKind, Channel, Paise, Timestamp } from '../domain/types.js';

/**
 * Append-only audit ledger.
 *
 * Deliberately an instance, not a static singleton: two strategies must be able
 * to run over the same cohort without their histories bleeding into each other,
 * and a test must start from a known-empty state.
 *
 * Timestamps are SIMULATION time, not wall-clock. An audit trail that records
 * when you happened to run the script, rather than when the event occurred, is
 * not an audit trail.
 */

export type EntryOutcome =
  /** The action passed the guardrails and ran. */
  | 'executed'
  /** A guardrail postponed it; it will be retried later. */
  | 'deferred'
  /** A guardrail refused it outright. */
  | 'blocked'
  /** The policy chose to stop working this case. */
  | 'stopped';

export interface LedgerEntry {
  readonly seq: number;
  readonly caseId: string;
  /** Simulation time at which this happened. */
  readonly at: Timestamp;
  readonly actionKind: ActionKind;
  readonly channel: Channel | undefined;
  readonly outcome: EntryOutcome;
  /** Present for executed actions. */
  readonly succeeded: boolean | undefined;
  /** Why the POLICY proposed this. */
  readonly rationale: string;
  /** Which guardrail rule fired, for deferred and blocked entries. */
  readonly rule: string | undefined;
  /** Why the GUARDRAIL ruled as it did. */
  readonly explanation: string | undefined;
  /** When a deferred action was rescheduled to. */
  readonly deferredTo: Timestamp | undefined;
  readonly costPaise: Paise;
  readonly spamPoints: number;
}

export type NewEntry = Omit<LedgerEntry, 'seq'>;

export class Ledger {
  private readonly entries: LedgerEntry[] = [];

  append(entry: NewEntry): LedgerEntry {
    const record: LedgerEntry = Object.freeze({ ...entry, seq: this.entries.length });
    this.entries.push(record);
    return record;
  }

  /** Everything recorded, in the order it happened. */
  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  forCase(caseId: string): readonly LedgerEntry[] {
    return this.entries.filter((e) => e.caseId === caseId);
  }

  /** Every action a guardrail refused. The compliance evidence. */
  blocked(): readonly LedgerEntry[] {
    return this.entries.filter((e) => e.outcome === 'blocked');
  }

  /** Every action a guardrail postponed rather than dropped. */
  deferred(): readonly LedgerEntry[] {
    return this.entries.filter((e) => e.outcome === 'deferred');
  }

  /** Count of each guardrail rule that fired. */
  ruleTally(): Record<string, number> {
    const tally: Record<string, number> = {};
    for (const e of this.entries) {
      if (!e.rule) continue;
      tally[e.rule] = (tally[e.rule] ?? 0) + 1;
    }
    return tally;
  }

  /** Newline-delimited JSON, one entry per line. The archival format. */
  toJSONL(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n');
  }

  get size(): number {
    return this.entries.length;
  }
}
