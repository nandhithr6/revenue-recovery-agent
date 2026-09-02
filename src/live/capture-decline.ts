import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lookupReason } from '../domain/failure-taxonomy.js';
import { HOUR, type LossEvent } from '../domain/types.js';
import { DEFAULT_GUARDRAILS, gate } from '../guardrails/index.js';
import { createRulesAgent } from '../policies/rules-agent.js';
import type { HistoryEntry } from '../policies/types.js';
import { DEFAULT_COSTS } from '../sim/scenario.js';
import { requireTestCredentials } from './env.js';
import { RazorpayApiError, RazorpayClient, type RazorpayPayment } from './razorpay-client.js';

/**
 * Capture a GENUINE decline from Razorpay, then run the unmodified agent on it.
 *
 * `run-live.ts` seeds each failure reason, because producing a real decline is
 * not a server-side operation: it needs Razorpay's hosted checkout driven with
 * one of their failure test cards. This script closes that gap.
 *
 *   npm run decline:create           -> creates a payment link, prints the URL
 *   (pay it with a failure test card at that URL)
 *   npm run decline:capture <plink>  -> reads the real failed payment back and
 *                                       feeds its real error fields to the agent
 *
 * The error object that comes back is Razorpay's own: `error_code`,
 * `error_reason`, `error_source`, `error_step`. Nothing about it is written by
 * us, which is the point -- it tests whether our taxonomy actually matches what
 * the API emits, rather than what the documentation says it emits.
 */

/** Failure test cards, from Razorpay's documented list. */
const FAILURE_CARDS: readonly { card: string; produces: string }[] = [
  { card: '4100 2800 0002 0007', produces: 'gateway_technical_error' },
  { card: '4100 2800 0008 0001', produces: 'insufficient_fund' },
  { card: '4100 2800 0000 0009', produces: 'authentication_failed' },
  { card: '4100 2800 0003 0006', produces: 'card_disabled_for_online_payments' },
];

async function create(client: RazorpayClient): Promise<void> {
  const link = await client.createPaymentLink({
    amountPaise: 129_900,
    description: 'Live decline capture — revenue recovery agent',
    customerName: 'Test Customer',
    customerEmail: 'test@example.com',
    notes: { purpose: 'capture_real_decline' },
  });

  console.log('\nPayment link created.\n');
  console.log(`  id  : ${link.id}`);
  console.log(`  url : ${link.short_url}`);
  console.log(`  amt : ₹${(link.amount / 100).toLocaleString('en-IN')}\n`);
  console.log('Pay it with one of these failure test cards (any future expiry, any CVV):\n');
  for (const c of FAILURE_CARDS) {
    console.log(`  ${c.card}   ->  ${c.produces}`);
  }
  console.log(`\nThen: npm run decline:capture ${link.id}\n`);
}

/** Everything Razorpay told us about the failure. Not paraphrased. */
function describeError(p: RazorpayPayment): Record<string, string | null | undefined> {
  return {
    payment_id: p.id,
    status: p.status,
    method: p.method,
    error_code: p.error_code,
    error_description: p.error_description,
    error_source: p.error_source,
    error_step: p.error_step,
    error_reason: p.error_reason,
  };
}

async function capture(client: RazorpayClient, linkId: string): Promise<void> {
  const link = await client.fetchPaymentLink(linkId);
  console.log(`\nPayment link ${link.id} — status ${link.status}\n`);

  // A payment link's own `payments` array lists only successful attempts, so a
  // decline never appears there — which was a surprise, and is exactly the kind
  // of thing you only learn by calling the API. Read the account's recent
  // payments instead and match on amount; the failures are the whole point here.
  const recent = await client.recentPayments(20);
  const matching = recent.filter((p) => p.amount === link.amount);
  const failed = matching.filter((p) => p.status === 'failed');

  if (matching.length === 0) {
    console.log('No payment attempts found for this amount yet. Pay the link first.\n');
    return;
  }
  console.log(`${matching.length} attempt(s) at this amount, ${failed.length} failed.\n`);

  const target = failed[0] ?? matching[0]!;
  const detail = describeError(target);

  console.log('=== What Razorpay actually returned ===');
  for (const [k, v] of Object.entries(detail)) {
    console.log(`  ${k.padEnd(18)} ${v ?? '—'}`);
  }

  const reasonCode = target.error_reason ?? undefined;
  const known = reasonCode ? lookupReason(reasonCode) : undefined;

  console.log('\n=== Does our taxonomy recognise it? ===');
  if (!reasonCode) {
    console.log('  No error_reason on the payment; nothing to classify.\n');
    return;
  }
  if (!known) {
    // A finding, not a failure. The taxonomy was built from the documentation,
    // and the API is the authority.
    console.log(`  NO — "${reasonCode}" is not in our taxonomy.`);
    console.log('  That is a real finding: the docs and the API disagree, and the API wins.\n');
  } else {
    console.log(`  YES — "${reasonCode}" maps to ${known.recoveryClass}`);
    console.log(`  ${known.description}\n`);
  }

  if (!known) return;

  // ---- Run the unmodified agent on the real failure. -------------------
  const agent = createRulesAgent(DEFAULT_COSTS);
  const occurredAt = Date.now() - 1 * HOUR;

  const event: LossEvent = {
    id: target.id,
    lossType: 'payment_failure',
    merchantId: 'live_merchant',
    amountPaise: target.amount,
    method: 'card',
    reasonCode,
    occurredAt,
    customer: {
      id: 'live_cust_decline',
      dndRegistered: false,
      consent: { email: true, sms: false, whatsapp: true, voice: false },
      utcOffsetMinutes: 330,
      respondsToNudge: true,
    },
  };

  console.log('=== What the agent decided, on the real failure ===');
  const history: HistoryEntry[] = [];
  const decisions: unknown[] = [];
  let now = Date.now();

  for (let step = 0; step < 4; step++) {
    const action = agent.decide({
      event,
      now,
      history,
      attemptCount: history.filter((h) => h.action.kind === 'retry_payment' && !h.blockedBy).length,
      contactCount: history.filter((h) => h.action.kind === 'contact_customer' && !h.blockedBy).length,
      channelsUsed: history
        .filter((h) => h.action.kind === 'contact_customer' && !h.blockedBy)
        .flatMap((h) => (h.action.channel ? [h.action.channel] : [])),
    });

    if (action.kind === 'stop') {
      console.log(`  stop — ${action.rationale}`);
      decisions.push({ step, kind: 'stop', rationale: action.rationale });
      break;
    }

    const at = now + action.delayMs;
    const verdict = gate(
      { action, customer: event.customer, at, caseOpenedAt: occurredAt, history },
      DEFAULT_GUARDRAILS,
    );

    console.log(
      `  ${action.kind}${action.channel ? ` (${action.channel})` : ''} — ${verdict.kind}` +
        (verdict.kind !== 'allow' ? ` [${verdict.rule}]` : ''),
    );
    console.log(`      ${action.rationale}`);
    decisions.push({
      step,
      kind: action.kind,
      channel: action.channel,
      rationale: action.rationale,
      verdict: verdict.kind,
      rule: verdict.kind !== 'allow' ? verdict.rule : undefined,
    });

    if (verdict.kind === 'defer') {
      now = verdict.notBefore;
      continue;
    }
    if (verdict.kind === 'block') {
      history.push({ at, action, succeeded: false, blockedBy: verdict.rule });
      now = at;
      continue;
    }
    history.push({ at, action, succeeded: false });
    now = at;
  }

  await mkdir('out', { recursive: true });
  const path = join('out', 'live-decline.json');
  await writeFile(
    path,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: 'razorpay_test',
        note:
          'A genuine decline produced by paying a real Razorpay payment link with one of their ' +
          'documented failure test cards. The error fields below are Razorpay-authored, not ours.',
        paymentLinkId: linkId,
        razorpayError: detail,
        taxonomyRecognised: Boolean(known),
        recoveryClass: known?.recoveryClass ?? null,
        agentDecisions: decisions,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\nWrote ${path}\n`);
}

async function main(): Promise<void> {
  const creds = requireTestCredentials();
  const client = new RazorpayClient(creds);
  const [mode, arg] = process.argv.slice(2);

  if (mode === 'create') return create(client);
  if (mode === 'capture') {
    if (!arg) throw new Error('Usage: npm run decline:capture <plink_id>');
    return capture(client, arg);
  }
  throw new Error('Usage: tsx src/live/capture-decline.ts create | capture <plink_id>');
}

try {
  await main();
} catch (e) {
  if (e instanceof RazorpayApiError) console.error(`\nRazorpay API error (${e.status}): ${e.message}\n`);
  else console.error(`\n${(e as Error).message}\n`);
  process.exitCode = 1;
}
