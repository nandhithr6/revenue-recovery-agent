import { existsSync, readFileSync } from 'node:fs';

/**
 * Minimal .env reader.
 *
 * Deliberately dependency-free: this file handles credentials, and a
 * transitive dependency in the path that reads secrets is a supply-chain
 * surface we do not need for twenty lines of parsing.
 */
export function loadEnv(path = '.env'): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) out[key] = value;
  }
  return out;
}

export interface RazorpayCredentials {
  readonly keyId: string;
  readonly keySecret: string;
}

/**
 * Read Razorpay credentials, refusing anything that is not a test key.
 *
 * The prefix check is the whole point. This code creates orders and payment
 * links; pointed at a live key it would create real ones against a real
 * merchant account. A hackathon project has no business being able to do that
 * by accident, so the guard is here rather than in a comment.
 */
export function requireTestCredentials(env = loadEnv()): RazorpayCredentials {
  const keyId = env['RAZORPAY_KEY_ID'] ?? process.env['RAZORPAY_KEY_ID'] ?? '';
  const keySecret = env['RAZORPAY_KEY_SECRET'] ?? process.env['RAZORPAY_KEY_SECRET'] ?? '';

  if (!keyId || !keySecret) {
    throw new Error(
      'Razorpay credentials missing. Copy .env.example to .env and fill in your TEST keys ' +
        '(Dashboard -> Settings -> API Keys, with the Test Mode toggle on).',
    );
  }

  if (!keyId.startsWith('rzp_test_')) {
    throw new Error(
      `Refusing to run: RAZORPAY_KEY_ID does not start with "rzp_test_". ` +
        `This script creates real orders and payment links, and must never be pointed at a live account.`,
    );
  }

  return { keyId, keySecret };
}

/** Redact a credential for logging. Never print the value itself. */
export function redact(secret: string): string {
  if (secret.length <= 8) return '***';
  return `${secret.slice(0, 12)}...(${secret.length} chars)`;
}
