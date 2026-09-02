/**
 * Provider-agnostic LLM client.
 *
 * Written against the OpenAI-compatible chat-completions shape, which Groq,
 * OpenRouter, Cerebras and several others all speak. Switching provider is a
 * base URL and a key, not a rewrite — which matters when the plan is to run
 * entirely on free tiers and one of them starts rate-limiting mid-demo.
 *
 * No API key configured is a normal state, not an error. The system is designed
 * to run fully without one.
 */

export interface LlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

/** Known free-tier providers, for documentation and easy switching. */
export const PROVIDERS = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b' },
} as const;

export function configFromEnv(): LlmConfig | undefined {
  const apiKey = process.env['LLM_API_KEY'];
  if (!apiKey) return undefined;

  const provider = (process.env['LLM_PROVIDER'] ?? 'groq') as keyof typeof PROVIDERS;
  const preset = PROVIDERS[provider] ?? PROVIDERS.groq;

  return {
    baseUrl: process.env['LLM_BASE_URL'] ?? preset.baseUrl,
    apiKey,
    model: process.env['LLM_MODEL'] ?? preset.model,
    timeoutMs: Number(process.env['LLM_TIMEOUT_MS'] ?? 15_000),
    maxRetries: Number(process.env['LLM_MAX_RETRIES'] ?? 2),
  };
}

export type CompletionResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: string };

/**
 * One chat completion. Never throws.
 *
 * Every failure mode — network, timeout, rate limit, malformed response — is
 * returned as a value, because the caller's correct response to all of them is
 * identical: fall back to the deterministic policy and keep going. A batch of
 * 500 cases must not die because request 217 hit a 429.
 */
export async function complete(
  config: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<CompletionResult> {
  let lastError = 'unknown error';

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          // Low but non-zero: we want consistency, not determinism theatre.
          temperature: 0.2,
          max_tokens: 300,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        // Rate limits and server errors are worth another attempt; a 400 is not.
        if (response.status === 429 || response.status >= 500) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        return { ok: false, error: lastError };
      }

      const body = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        return { ok: false, error: 'response contained no content' };
      }
      return { ok: true, content };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < config.maxRetries) await sleep(250 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, error: lastError };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
