import { lookupReason } from '../domain/failure-taxonomy.js';
import { CHANNELS, HOUR, type Action, type Channel, type LossEvent } from '../domain/types.js';
import { complete, type LlmConfig } from '../llm/client.js';
import { parseDecision, type LlmDecision } from '../llm/schema.js';
import type { CostModel } from '../sim/scenario.js';
import { createRulesAgent } from './rules-agent.js';
import type { CaseContext, Strategy } from './types.js';

/**
 * LLM-driven recovery policy.
 *
 * Two things about this design are deliberate and worth reading before the code.
 *
 * 1. **It is never a dependency.** No API key, a rate limit, a timeout, a
 *    malformed response, an unparseable field: every one of those falls back to
 *    the deterministic rules agent. The system runs identically with the network
 *    unplugged. An LLM that can take down a batch of 500 recovery cases is not
 *    an improvement over a lookup table.
 *
 * 2. **Decisions are cached by situation, not by case.** Two ₹800 UPI payments
 *    that both failed with `insufficient_funds` on their first attempt are the
 *    same decision problem. Asking a model twice costs two requests and returns
 *    the same answer. Bucketing collapses ~500 cases into ~60 distinct
 *    situations, which is the difference between fitting inside a free tier and
 *    not.
 */

const SYSTEM_PROMPT = `You are a payment recovery policy engine for an Indian payment gateway.

Given a failed payment, decide the single next recovery action.

Key domain facts:
- bank_technical_error / gateway_technical_error: infrastructure was down. Retrying immediately fails; waiting 30-60 minutes works well. Do not message the customer about our own downtime.
- insufficient_funds / transaction_limit_exceeded: only time fixes this. Retry after ~20 hours, not sooner.
- card_expired / invalid_vpa / card_not_enrolled: the instrument is dead. NO retry can ever succeed. The customer must fix it, so contact them.
- payment_cancelled / payment_timed_out: the customer walked away. Purchase intent decays hourly, so act fast.
- payment_risk_check_failed / debit_instrument_blocked / card_declined: the bank refused with prejudice. Retrying is futile and repeated attempts can harm the merchant's authorisation rates. Stop.
- incorrect_cvv / authentication_failed: a corrected attempt can work after a short pause.

Contacting customers costs goodwill: email is cheap, SMS and WhatsApp are moderately intrusive, voice is very intrusive. Only use louder channels when the amount justifies it.

Respond with ONLY a JSON object:
{"action":"retry_payment"|"contact_customer"|"stop"|"escalate_human","channel":"email"|"sms"|"whatsapp"|"voice","delay_hours":number,"reasoning":"one short sentence"}

"channel" is required only for contact_customer. delay_hours must be between 0 and 168.`;

/** Coarse value bands. Precision here would only fragment the cache. */
function amountBucket(amountPaise: number): string {
  if (amountPaise < 50_000) return 'small';
  if (amountPaise < 500_000) return 'medium';
  if (amountPaise < 5_000_000) return 'large';
  return 'very_large';
}

/**
 * The situation key. Two cases sharing a key are the same decision problem, so
 * they share an answer.
 */
export function situationKey(ctx: CaseContext): string {
  const channels = CHANNELS.filter((c) => ctx.event.customer.consent[c]).join(',');
  return [
    ctx.event.reasonCode ?? 'unknown',
    amountBucket(ctx.event.amountPaise),
    `r${Math.min(ctx.attemptCount, 3)}`,
    `c${Math.min(ctx.contactCount, 2)}`,
    channels || 'none',
  ].join('|');
}

/**
 * The compact payload sent to the model.
 *
 * Deliberately not the raw case history. Sending a full ledger would burn tokens,
 * hit free-tier limits faster, and give a small model more chances to fixate on
 * something irrelevant. Rupees rather than paise here: it is the boundary where
 * human-readable units genuinely help the reader.
 */
export function buildPayload(ctx: CaseContext): Record<string, unknown> {
  const reason = ctx.event.reasonCode ? lookupReason(ctx.event.reasonCode) : undefined;
  return {
    error_code: ctx.event.reasonCode ?? 'unknown',
    error_description: reason?.description ?? 'unrecognised failure',
    payment_method: ctx.event.method,
    amount_inr: Math.round(ctx.event.amountPaise / 100),
    loss_type: ctx.event.lossType,
    hours_since_failure: Number(((ctx.now - ctx.event.occurredAt) / HOUR).toFixed(1)),
    retries_so_far: ctx.attemptCount,
    contacts_so_far: ctx.contactCount,
    available_channels: CHANNELS.filter((c) => ctx.event.customer.consent[c]),
    channels_already_used: ctx.channelsUsed,
  };
}

function toAction(decision: LlmDecision): Action {
  const delayMs = Math.round(decision.delay_hours * HOUR);
  const rationale = `LLM: ${decision.reasoning}`;

  switch (decision.action) {
    case 'retry_payment':
      return { kind: 'retry_payment', delayMs, rationale };
    case 'contact_customer':
      return {
        kind: 'contact_customer',
        channel: decision.channel as Channel,
        delayMs,
        rationale,
      };
    case 'escalate_human':
      return { kind: 'escalate_human', delayMs, rationale };
    case 'stop':
      return { kind: 'stop', delayMs: 0, rationale };
  }
}

export interface LlmStats {
  requests: number;
  cacheHits: number;
  parseFailures: number;
  transportFailures: number;
  fallbacks: number;
}

export class LlmDecisionCache {
  private readonly entries = new Map<string, LlmDecision>();
  readonly stats: LlmStats = {
    requests: 0,
    cacheHits: 0,
    parseFailures: 0,
    transportFailures: 0,
    fallbacks: 0,
  };

  get(key: string): LlmDecision | undefined {
    const hit = this.entries.get(key);
    if (hit) this.stats.cacheHits += 1;
    return hit;
  }

  /**
   * Resolve every distinct situation in a cohort up front.
   *
   * Sequential rather than parallel, on purpose: free tiers rate-limit on
   * requests per minute, and a burst of 60 concurrent calls is the fastest way
   * to get a wall of 429s.
   */
  async prewarm(
    events: readonly LossEvent[],
    config: LlmConfig,
    buildCtx: (event: LossEvent) => CaseContext,
  ): Promise<void> {
    const seen = new Set<string>();

    for (const event of events) {
      const ctx = buildCtx(event);
      const key = situationKey(ctx);
      if (seen.has(key)) continue;
      seen.add(key);

      this.stats.requests += 1;
      const response = await complete(
        config,
        SYSTEM_PROMPT,
        JSON.stringify(buildPayload(ctx)),
      );

      if (!response.ok) {
        this.stats.transportFailures += 1;
        continue;
      }

      const parsed = parseDecision(response.content);
      if (!parsed.ok) {
        this.stats.parseFailures += 1;
        continue;
      }

      this.entries.set(key, parsed.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * The LLM policy. Consults the cache; falls back to the rules agent for anything
 * it does not have a validated answer for.
 */
export function createLlmAgent(costs: CostModel, cache: LlmDecisionCache): Strategy {
  const fallback = createRulesAgent(costs);

  return {
    id: 'agent-llm',
    name: 'LLM agent',
    description:
      'An LLM proposes each recovery action from a compact payload, validated against a schema before it reaches the guardrails. Falls back to the deterministic agent whenever the model is unavailable or its output does not validate.',

    decide(ctx: CaseContext): Action {
      const decision = cache.get(situationKey(ctx));
      if (!decision) {
        cache.stats.fallbacks += 1;
        return fallback.decide(ctx);
      }
      return toAction(decision);
    },
  };
}
