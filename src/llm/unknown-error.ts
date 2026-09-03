import type { RecoveryClass } from '../domain/failure-taxonomy.js';
import type { FallbackInterpretation, UnknownReasonInterpreter } from '../policies/assessment.js';
import { complete, type LlmConfig } from './client.js';

/**
 * Optional LLM interpretation of a reason code the taxonomy doesn't
 * recognise -- the ONLY thing an LLM is allowed to touch in this project's
 * unknown-case handling (see the design review, Part 2, and ADR 0003, which
 * this does not revisit: the earlier, separate finding that an LLM-driven
 * POLICY underperforms the deterministic one stands unchanged, because this
 * is not a policy. It cannot select an action, price a candidate, or reach a
 * guardrail. Its entire output is a class guess and a sentence of evidence,
 * fed into `assessment.ts:assess()` exactly where the deterministic
 * fallback's guess would go -- and, same as that fallback, it is
 * structurally incapable of producing anything above MEDIUM confidence: this
 * file hardcodes that cap rather than trusting whatever confidence the model
 * itself claims.
 *
 * Same operating rule as `llm-agent.ts`: no API key is a normal state. Every
 * cohort in the existing financial benchmark runs with zero unknown reason
 * codes (the generator has never produced one), so this cache is normally
 * empty and this file is normally never on the hot path at all -- its real
 * exercise ground is `eval/novelty.ts`.
 */

const CLASS_LIST: readonly RecoveryClass[] = [
  'TRANSIENT_INFRA',
  'TRANSIENT_FUNDS',
  'CUSTOMER_ACTION_REQUIRED',
  'ABANDONMENT',
  'AUTH_FAILURE',
  'HARD_DECLINE',
];

const SYSTEM_PROMPT = `You classify an UNRECOGNISED payment failure reason code into one of six known categories, or none if it genuinely doesn't fit.

Categories:
- TRANSIENT_INFRA: bank or gateway infrastructure was down, nothing wrong with the customer or instrument.
- TRANSIENT_FUNDS: not enough money, or a limit was hit. Only time fixes it.
- CUSTOMER_ACTION_REQUIRED: the instrument itself is dead (expired, disabled, unregistered). Retrying can never work; the customer must fix something.
- ABANDONMENT: the customer walked away mid-flow. Intent may still exist.
- AUTH_FAILURE: a fumbled credential (OTP, CVV). A corrected attempt can work.
- HARD_DECLINE: the bank or a risk engine refused with prejudice. Do not push.

Respond with ONLY a JSON object: {"recovery_class": one of the six names above, or null if none fit; "evidence": "one short sentence explaining the match or why nothing fits"}.`;

/** Never trust a model's own confidence claim -- this file decides it, once, here. */
const LLM_CONFIDENCE = 'medium' as const;

interface RawInterpretation {
  readonly recovery_class: string | null;
  readonly evidence: string;
}

function isClass(x: unknown): x is RecoveryClass {
  return typeof x === 'string' && (CLASS_LIST as readonly string[]).includes(x);
}

function parse(raw: string): FallbackInterpretation | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Partial<RawInterpretation>;
  const evidence = typeof obj.evidence === 'string' && obj.evidence.length > 0 ? obj.evidence : 'LLM interpretation, no evidence text returned';

  if (obj.recovery_class === null) {
    return { recoveryClass: null, confidence: 'low', evidence: [`LLM: ${evidence}`] };
  }
  if (!isClass(obj.recovery_class)) return undefined;
  return { recoveryClass: obj.recovery_class, confidence: LLM_CONFIDENCE, evidence: [`LLM: ${evidence}`] };
}

export interface UnknownErrorStats {
  requests: number;
  cacheHits: number;
  parseFailures: number;
  transportFailures: number;
  loadedFromDisk: number;
}

/** Same shape as `LlmDecisionCache` -- one cache entry per unrecognised reason code, keyed by the code itself (there is no richer situation to bucket by here). */
export class UnknownErrorCache {
  private readonly entries = new Map<string, FallbackInterpretation>();
  readonly stats: UnknownErrorStats = {
    requests: 0,
    cacheHits: 0,
    parseFailures: 0,
    transportFailures: 0,
    loadedFromDisk: 0,
  };

  get(reasonCode: string): FallbackInterpretation | undefined {
    const hit = this.entries.get(reasonCode);
    if (hit) this.stats.cacheHits += 1;
    return hit;
  }

  get size(): number {
    return this.entries.size;
  }

  async prewarm(reasonCodes: readonly string[], config: LlmConfig, gapMs = 2_100): Promise<void> {
    const seen = new Set<string>();
    let called = false;

    for (const code of reasonCodes) {
      if (seen.has(code)) continue;
      seen.add(code);
      if (this.entries.has(code)) {
        this.stats.cacheHits += 1;
        continue;
      }

      if (called) await new Promise((r) => setTimeout(r, gapMs));
      called = true;

      this.stats.requests += 1;
      const response = await complete(config, SYSTEM_PROMPT, JSON.stringify({ reason_code: code }));
      if (!response.ok) {
        this.stats.transportFailures += 1;
        continue;
      }
      const parsed = parse(response.content);
      if (!parsed) {
        this.stats.parseFailures += 1;
        continue;
      }
      this.entries.set(code, parsed);
    }
  }

  toJSON(): Record<string, FallbackInterpretation> {
    return Object.fromEntries(this.entries);
  }

  load(raw: Record<string, FallbackInterpretation>): void {
    for (const [k, v] of Object.entries(raw)) this.entries.set(k, v);
    this.stats.loadedFromDisk = this.entries.size;
  }
}

/**
 * Build the `UnknownReasonInterpreter` `assess()` accepts. Returns `undefined`
 * for anything not in the cache (including "never prewarmed" -- the normal
 * state for this project's actual scenarios), which makes `assess()` fall
 * through to the always-available deterministic fallback automatically.
 */
export function createLlmInterpreter(cache: UnknownErrorCache): UnknownReasonInterpreter {
  return ({ reasonCode }) => cache.get(reasonCode);
}
