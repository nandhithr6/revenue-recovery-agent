import { z } from 'zod';

/**
 * Structural validation of model output.
 *
 * The rule this file exists to enforce: **nothing a language model produces
 * reaches the rest of the system as anything but a validated, typed object.**
 * Prompting a model to "respond only with JSON" is a request, not a guarantee.
 * Models wrap output in markdown fences, prepend "Here is the JSON:", emit
 * trailing commas, and invent fields. All of that is normal, and none of it
 * should be able to reach a guardrail stack.
 */

export const LlmDecisionSchema = z.object({
  action: z.enum(['retry_payment', 'contact_customer', 'stop', 'escalate_human']),
  channel: z.enum(['email', 'sms', 'whatsapp', 'voice']).optional(),
  /** Hours to wait before acting. Bounded so a model cannot schedule into 2043. */
  delay_hours: z.number().min(0).max(168),
  reasoning: z.string().min(1).max(500),
});

export type LlmDecision = z.infer<typeof LlmDecisionSchema>;

export type ParseResult =
  | { readonly ok: true; readonly value: LlmDecision }
  | { readonly ok: false; readonly error: string; readonly raw: string };

/**
 * Pull a JSON object out of whatever the model actually returned.
 *
 * Handles, in order: a bare object, a ```json fenced block, a plain ``` fenced
 * block, and finally the outermost {...} span anywhere in the text. Each is a
 * real failure mode observed from free-tier models, not defensive theatre.
 */
function extractJson(raw: string): string | undefined {
  const text = raw.trim();
  if (text.startsWith('{')) return text;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) return fenced[1].trim();

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) return text.slice(first, last + 1);

  return undefined;
}

/**
 * Parse and validate. Never throws: a malformed response is a normal event that
 * the caller handles by falling back to the deterministic policy, not an
 * exception that takes down a batch run.
 */
export function parseDecision(raw: string): ParseResult {
  const candidate = extractJson(raw);
  if (!candidate) {
    return { ok: false, error: 'no JSON object found in response', raw };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    return {
      ok: false,
      error: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
      raw,
    };
  }

  const result = LlmDecisionSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => i.message).join('; '), raw };
  }

  // A contact without a channel is structurally valid but semantically useless,
  // and the guardrail would reject it as MALFORMED_ACTION. Catch it here so the
  // fallback can do something sensible instead.
  if (result.data.action === 'contact_customer' && !result.data.channel) {
    return { ok: false, error: 'contact_customer requires a channel', raw };
  }

  return { ok: true, value: result.data };
}
