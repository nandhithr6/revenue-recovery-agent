import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lookupReason } from '../domain/failure-taxonomy.js';
import { HOUR, type LossEvent, type LossType } from '../domain/types.js';
import { DEFAULT_GUARDRAILS, gate } from '../guardrails/index.js';
import { Ledger } from '../ledger/ledger.js';
import { createRulesAgent } from '../policies/rules-agent.js';
import type { HistoryEntry } from '../policies/types.js';
import { DEFAULT_COSTS } from '../sim/scenario.js';
import { requireTestCredentials } from './env.js';
import { RazorpayClient, RazorpayApiError } from './razorpay-client.js';

/**
 * `npm run live` — the same agent, against the real Razorpay API.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 *
 * The simulator measures. It runs 500 cases across 50 seeds and produces the
 * recovery rates in the README. This script measures nothing: a handful of
 * hand-driven cases cannot support a statistical claim, and presenting them as
 * one would be the fastest way to lose a technical panel.
 *
 * What this proves is narrower and worth having: the policy runs on real rails.
 * The agent and the guardrails imported below are the SAME modules the
 * simulation uses, unmodified and unbranched -- there is no `if (live)` anywhere
 * above the execution layer. When the agent decides to contact a customer, a
 * real Razorpay payment link is created and its `plink_...` id lands in the
 * ledger. When it decides to retry, a real order is created.
 *
 * WHAT IS SEEDED, STATED PLAINLY
 *
 * The initial failure reason. Producing a genuine decline requires driving
 * Razorpay's hosted checkout in a browser with one of their failure test cards,
 * which is not a server-side operation. So each case starts from a real,
 * documented Razorpay reason code, and every recovery ACTION after that is a
 * real API call. The test card that would reproduce each failure by hand is
 * recorded alongside it.
 */

const SEED_CASES: readonly {
  reasonCode: string;
  lossType: LossType;
  amountPaise: number;
  /** The Razorpay test card that produces this failure at their hosted checkout. */
  testCard: string | null;
}[] = [
  { reasonCode: 'gateway_technical_error', lossType: 'payment_failure', amountPaise: 129_900, testCard: '4100 2800 0002 0007' },
  { reasonCode: 'insufficient_funds', lossType: 'subscription_mandate', amountPaise: 49_900, testCard: '4100 2800 0008 0001' },
  { reasonCode: 'card_expired', lossType: 'payment_failure', amountPaise: 275_000, testCard: null },
  { reasonCode: 'payment_cancelled', lossType: 'checkout_abandonment', amountPaise: 89_900, testCard: '4100 2800 0007 0002' },
  { reasonCode: 'payment_risk_check_failed', lossType: 'payment_failure', amountPaise: 1_450_000, testCard: null },
];

/** The engine's own backstop, mirrored here so a live run cannot loop. */
const MAX_STEPS = 4;

/**
 * Razorpay rate-limits test mode, and a burst of order creations earns a 429.
 * The simulation is where throughput is exercised; here we are polite.
 */
const API_GAP_MS = 400;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface LiveAction {
  readonly step: number;
  readonly decided: string;
  readonly channel?: string;
  readonly rationale: string;
  readonly verdict: string;
  readonly rule?: string;
  readonly explanation?: string;
  /** Real Razorpay identifiers produced by this action. */
  readonly razorpay?: Record<string, string>;
}

interface LiveCase {
  readonly caseId: string;
  readonly reasonCode: string;
  readonly recoveryClass: string;
  readonly lossType: string;
  readonly amountPaise: number;
  readonly testCardToReproduce: string | null;
  readonly orderId: string;
  readonly actions: readonly LiveAction[];
}

const inr = (paise: number): string => `₹${(paise / 100).toLocaleString('en-IN')}`;

async function main(): Promise<void> {
  const creds = requireTestCredentials();
  const client = new RazorpayClient(creds);

  console.log('\nRazorpay live run (TEST MODE)');
  console.log(`Key: ${creds.keyId.slice(0, 16)}... — verified test-mode prefix\n`);

  await client.ping();
  console.log('Credentials accepted.\n');

  // The unmodified agent. Same construction as the simulation uses.
  const agent = createRulesAgent(DEFAULT_COSTS);
  const ledger = new Ledger();
  const cases: LiveCase[] = [];

  for (const [index, seed] of SEED_CASES.entries()) {
    const reason = lookupReason(seed.reasonCode);
    if (!reason) throw new Error(`Unknown reason code in seed set: ${seed.reasonCode}`);

    const caseId = `live_${String(index + 1).padStart(3, '0')}`;
    const occurredAt = Date.now() - 2 * HOUR;

    // A real order, so the amount and receipt exist on Razorpay's side.
    await pause(API_GAP_MS);
    const order = await client.createOrder(seed.amountPaise, `rcpt_${caseId}`, {
      purpose: 'revenue-recovery-agent live run',
      seeded_failure_reason: seed.reasonCode,
    });

    console.log(
      `${caseId}  ${inr(seed.amountPaise).padStart(12)}  ${seed.reasonCode.padEnd(26)} ${reason.recoveryClass}`,
    );
    console.log(`         order ${order.id}`);

    const event: LossEvent = {
      id: caseId,
      lossType: seed.lossType,
      merchantId: 'live_merchant',
      amountPaise: seed.amountPaise,
      method: 'card',
      reasonCode: seed.reasonCode,
      occurredAt,
      // See domain/types.ts:DebitStatus / sim/generator.ts:deriveDebitStatus.
      debitStatus:
        (seed.lossType === 'payment_failure' || seed.lossType === 'subscription_mandate') &&
        seed.reasonCode === 'payment_timed_out'
          ? 'uncertain'
          : 'no_debit',
      customer: {
        id: `live_cust_${index + 1}`,
        dndRegistered: false,
        consent: { email: true, sms: false, whatsapp: true, voice: false },
        utcOffsetMinutes: 330,
        respondsToNudge: true,
      },
    };

    const history: HistoryEntry[] = [];
    const actions: LiveAction[] = [];
    let now = Date.now();

    for (let step = 0; step < MAX_STEPS; step++) {
      const action = agent.decide({
        event,
        now,
        history,
        attemptCount: history.filter(
          (h) => h.action.kind === 'retry_payment' && !h.blockedBy,
        ).length,
        contactCount: history.filter(
          (h) => h.action.kind === 'contact_customer' && !h.blockedBy,
        ).length,
        channelsUsed: history
          .filter((h) => h.action.kind === 'contact_customer' && !h.blockedBy)
          .flatMap((h) => (h.action.channel ? [h.action.channel] : [])),
      });

      if (action.kind === 'stop') {
        console.log(`         stop — ${action.rationale}`);
        actions.push({
          step,
          decided: 'stop',
          rationale: action.rationale,
          verdict: 'allow',
        });
        break;
      }

      const scheduledAt = now + action.delayMs;

      // The SAME guardrail gate the simulation uses. Not a copy.
      const verdict = gate(
        { action, customer: event.customer, at: scheduledAt, caseOpenedAt: occurredAt, history },
        DEFAULT_GUARDRAILS,
      );

      if (verdict.kind !== 'allow') {
        console.log(`         ${verdict.kind} — ${verdict.rule}`);
        actions.push({
          step,
          decided: action.kind,
          ...(action.channel ? { channel: action.channel } : {}),
          rationale: action.rationale,
          verdict: verdict.kind,
          rule: verdict.rule,
          explanation: verdict.explanation,
        });

        if (verdict.kind === 'defer') {
          // Advance the clock to when the action becomes permitted, exactly as
          // the simulation engine does. Holding `now` still instead was a real
          // bug: the cooldown could never clear, so the agent re-proposed the
          // same retry until the step limit. A deferral is also NOT a block, so
          // it must not enter history as one -- that would teach the agent a
          // rule had permanently refused it.
          now = verdict.notBefore;
          continue;
        }

        history.push({ at: scheduledAt, action, succeeded: false, blockedBy: verdict.rule });
        now = scheduledAt;
        continue;
      }

      // ---- Execute for real. -------------------------------------------
      const razorpay: Record<string, string> = {};

      await pause(API_GAP_MS);

      if (action.kind === 'contact_customer') {
        const link = await client.createPaymentLink({
          amountPaise: seed.amountPaise,
          description: `Recovery for ${caseId} — ${seed.reasonCode}`,
          customerName: 'Test Customer',
          customerEmail: 'test@example.com',
          notes: { case_id: caseId, reason: seed.reasonCode, channel: action.channel ?? '' },
        });
        razorpay['payment_link_id'] = link.id;
        razorpay['short_url'] = link.short_url;
        console.log(`         contact via ${action.channel} → ${link.id}  ${link.short_url}`);
      } else if (action.kind === 'retry_payment') {
        const retryOrder = await client.createOrder(
          seed.amountPaise,
          `rcpt_${caseId}_r${step}`,
          { case_id: caseId, attempt: String(step) },
        );
        razorpay['order_id'] = retryOrder.id;
        console.log(`         retry → order ${retryOrder.id}`);
      } else {
        console.log(`         ${action.kind}`);
      }

      history.push({ at: scheduledAt, action, succeeded: false });
      actions.push({
        step,
        decided: action.kind,
        ...(action.channel ? { channel: action.channel } : {}),
        rationale: action.rationale,
        verdict: 'allow',
        ...(Object.keys(razorpay).length ? { razorpay } : {}),
      });

      ledger.append({
        caseId,
        at: scheduledAt,
        actionKind: action.kind,
        channel: action.channel,
        outcome: 'executed',
        succeeded: false,
        rationale: action.rationale,
        rule: undefined,
        explanation: Object.keys(razorpay).length ? JSON.stringify(razorpay) : undefined,
        deferredTo: undefined,
        costPaise: 0,
        spamPoints: 0,
      });

      now = scheduledAt;
    }

    cases.push({
      caseId,
      reasonCode: seed.reasonCode,
      recoveryClass: reason.recoveryClass,
      lossType: seed.lossType,
      amountPaise: seed.amountPaise,
      testCardToReproduce: seed.testCard,
      orderId: order.id,
      actions,
    });

    console.log('');
  }

  const linkCount = cases.reduce(
    (n, c) => n + c.actions.filter((a) => a.razorpay?.['payment_link_id']).length,
    0,
  );
  const orderCount = cases.length + cases.reduce(
    (n, c) => n + c.actions.filter((a) => a.razorpay?.['order_id']).length,
    0,
  );

  console.log('=== Summary ===');
  console.log(`${cases.length} cases driven through the unmodified agent and guardrails.`);
  console.log(`${orderCount} real Razorpay orders created, ${linkCount} real payment links.`);
  console.log('No money moved: test mode throughout.\n');

  await mkdir('out', { recursive: true });
  const path = join('out', 'live-run.json');
  await writeFile(
    path,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: 'razorpay_test',
        note:
          'Recovery actions are real Razorpay API calls. The initial failure reason on each ' +
          'case is seeded from Razorpay documented codes, because producing a genuine decline ' +
          'requires driving their hosted checkout in a browser. This run measures nothing; ' +
          'the statistical claims come from the seeded simulator.',
        cases,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`Wrote ${path}\n`);
}

try {
  await main();
} catch (e) {
  if (e instanceof RazorpayApiError) {
    console.error(`\nRazorpay API error (${e.status}): ${e.message}\n`);
  } else {
    console.error(`\n${(e as Error).message}\n`);
  }
  process.exitCode = 1;
}
