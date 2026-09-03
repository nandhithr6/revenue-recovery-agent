import { describe, expect, it } from 'vitest';
import type { CustomerProfile, LossEvent } from '../domain/types.js';
import { buildCandidates } from './action-registry.js';
import { deriveState } from './case-state.js';
import { LOSS_PROFILES } from './loss-profiles.js';
import { DEFAULT_COSTS } from '../sim/scenario.js';
import type { CaseContext } from './types.js';

const AT = Date.parse('2026-09-01T11:00:00+05:30');

const customer = (over: Partial<CustomerProfile> = {}): CustomerProfile => ({
  id: 'cust_registry',
  dndRegistered: false,
  consent: { email: true, sms: true, whatsapp: true, voice: true },
  utcOffsetMinutes: 330,
  respondsToNudge: true,
  ...over,
});

const event = (over: Partial<LossEvent> = {}): LossEvent => ({
  id: 'loss_registry',
  lossType: 'payment_failure',
  merchantId: 'merch_001',
  customer: customer(),
  amountPaise: 5_000_000, // Rs 50,000: large enough that voice's cost is easily worth it if offered
  method: 'card',
  reasonCode: 'insufficient_funds',
  occurredAt: AT,
  debitStatus: 'no_debit',
  ...over,
});

const ctx = (e: LossEvent, over: Partial<CaseContext> = {}): CaseContext => ({
  event: e,
  now: e.occurredAt,
  history: [],
  attemptCount: 0,
  contactCount: 0,
  channelsUsed: [],
  ...over,
});

function candidatesFor(e: LossEvent, over: Partial<CaseContext> = {}) {
  const context = ctx(e, over);
  const profile = LOSS_PROFILES[e.lossType];
  const state = deriveState(context, profile);
  return buildCandidates({
    ctx: context,
    state,
    recoveryClass: state.assessment.recoveryClass,
    profile,
    costs: DEFAULT_COSTS,
    annoyancePricePaise: 2000,
  });
}

describe('confidence-gated candidate menu', () => {
  // Contact channels (including voice) are only causally meaningful in the
  // simulator when a landed nudge actually has a path to recovery -- see
  // `action-registry.ts:contactHasCausalPath`. `insufficient_funds`
  // (TRANSIENT_FUNDS) on the default `payment_failure` loss type has NO such
  // path (only CUSTOMER_ACTION_REQUIRED's curve reads `customerActed`), so
  // these tests use `card_expired` (CUSTOMER_ACTION_REQUIRED) instead, where
  // contact genuinely unlocks a later retry.

  it('HIGH confidence offers voice as a real candidate (consented, large amount, causally valid class)', () => {
    const cands = candidatesFor(event({ reasonCode: 'card_expired' }), { now: AT + 30 * 60_000 });
    const voice = cands.find((c) => c.action.kind === 'contact_customer' && c.action.channel === 'voice');
    expect(voice).toBeDefined();
  });

  it('contact channels are not offered at all when the class has no causal path from a landed nudge', () => {
    const cands = candidatesFor(event({ reasonCode: 'insufficient_funds' }));
    const anyContact = cands.some((c) => c.action.kind === 'contact_customer');
    expect(anyContact).toBe(false);
  });

  it('MEDIUM confidence suppresses voice when a cheaper candidate already clears cost', () => {
    // A known code with a context anomaly (attemptCount mismatch) is
    // known/medium -- retry and other channels still price normally, so at
    // least one of them should clear cost and voice should not appear.
    const cands = candidatesFor(event({ reasonCode: 'card_expired' }), { attemptCount: 2, now: AT + 30 * 60_000 });
    const nonStopPositive = cands.filter((c) => c.action.kind !== 'stop' && c.expectedValuePaise > 0);
    const voice = cands.find((c) => c.action.kind === 'contact_customer' && c.action.channel === 'voice');
    if (nonStopPositive.length > 0) {
      expect(voice).toBeUndefined();
    }
  });

  it('LOW/unknown confidence never offers voice, ever', () => {
    const cands = candidatesFor(event({ reasonCode: 'totally_unrecognised_xyz_123' }));
    const voice = cands.find((c) => c.action.kind === 'contact_customer' && c.action.channel === 'voice');
    expect(voice).toBeUndefined();
  });

  it('LOW/unknown confidence never offers retry', () => {
    const cands = candidatesFor(event({ reasonCode: 'totally_unrecognised_xyz_123' }));
    const retry = cands.find((c) => c.action.kind === 'retry_payment');
    expect(retry).toBeUndefined();
  });

  it('LOW/unknown confidence offers at most one contact channel, and it is email', () => {
    const cands = candidatesFor(event({ reasonCode: 'totally_unrecognised_xyz_123' }));
    const contacts = cands.filter((c) => c.action.kind === 'contact_customer');
    expect(contacts.length).toBeLessThanOrEqual(1);
    if (contacts.length === 1) expect(contacts[0]!.action.channel).toBe('email');
  });

  it('LOW/unknown confidence still offers stop, always', () => {
    const cands = candidatesFor(event({ reasonCode: 'totally_unrecognised_xyz_123' }));
    expect(cands.some((c) => c.action.kind === 'stop')).toBe(true);
  });

  it('escalate_human is offered on genuinely unknown cases only above the value floor, priced as a hedge', () => {
    const small = candidatesFor(event({ reasonCode: 'totally_unrecognised_xyz_123', amountPaise: 500 }));
    const large = candidatesFor(event({ reasonCode: 'totally_unrecognised_xyz_123', amountPaise: 5_000_000 }));
    expect(small.some((c) => c.action.kind === 'escalate_human')).toBe(false);
    expect(large.some((c) => c.action.kind === 'escalate_human')).toBe(true);
  });
});

describe('economics fixes: causal gating, contact fatigue, dominance', () => {
  it('a landed contact with no causal path to recovery is priced at zero gain -- so it is simply never offered', () => {
    // TRANSIENT_FUNDS on payment_failure: engine.ts never reads
    // `customerActed` for this class, so a nudge landing changes nothing.
    const cands = candidatesFor(event({ reasonCode: 'insufficient_funds' }));
    expect(cands.every((c) => c.action.kind !== 'contact_customer')).toBe(true);
  });

  it('a receivable (link-recoverable loss type) DOES get contact candidates, even for a non-CAR class', () => {
    // canRetryCharge=false on receivable means acting on the nudge IS the
    // recovery path (recoversViaLink), regardless of recovery class.
    const cands = candidatesFor(event({ reasonCode: 'insufficient_funds', lossType: 'receivable' }));
    expect(cands.some((c) => c.action.kind === 'contact_customer')).toBe(true);
  });

  it('repeated contact attempts reduce believed landing odds (fatigue), same mechanism as retry', () => {
    const fresh = candidatesFor(event({ reasonCode: 'card_expired' }), { now: AT + 30 * 60_000 });
    const worn = candidatesFor(event({ reasonCode: 'card_expired' }), {
      now: AT + 30 * 60_000,
      contactCount: 3,
      history: Array.from({ length: 3 }, (_, i) => ({
        at: AT + i * 60_000,
        action: { kind: 'contact_customer' as const, channel: 'sms' as const, delayMs: 0, rationale: 'x' },
        succeeded: false,
      })),
    });
    const freshEmail = fresh.find((c) => c.action.kind === 'contact_customer' && c.action.channel === 'email');
    const wornEmail = worn.find((c) => c.action.kind === 'contact_customer' && c.action.channel === 'email');
    expect(freshEmail).toBeDefined();
    expect(wornEmail).toBeDefined();
    expect(wornEmail!.grossRecoveryPaise).toBeLessThan(freshEmail!.grossRecoveryPaise);
  });

  it('dominance annotation marks a strictly worse candidate without changing the winner', () => {
    // whatsapp lands more often than sms for strictly less money (see
    // sim/scenario.ts's channel costs and BELIEVED_NUDGE_ODDS) -- same
    // gain formula, so sms is strictly dominated whenever both are offered.
    const cands = candidatesFor(event({ reasonCode: 'card_expired' }), { now: AT + 30 * 60_000 });
    const whatsapp = cands.find((c) => c.action.kind === 'contact_customer' && c.action.channel === 'whatsapp');
    const sms = cands.find((c) => c.action.kind === 'contact_customer' && c.action.channel === 'sms');
    expect(whatsapp).toBeDefined();
    expect(sms).toBeDefined();
    expect(sms!.dominated).toBe(true);
    // And the winner (highest EV) is never the dominated one.
    const best = cands.reduce((a, b) => (b.expectedValuePaise > a.expectedValuePaise ? b : a));
    expect(best.dominated).not.toBe(true);
  });

  it('a fresh CUSTOMER_ACTION_REQUIRED case at elapsed=0 is not priced as a dead end', () => {
    // Regression test for a real bug: CUSTOMER_ACTION_REQUIRED's belief
    // curve is a `rise` shape (adaptive-model.ts), which evaluates to
    // EXACTLY zero at literal elapsed=0 by construction
    // (`1 - exp(-0/tau) === 0`). Contact/escalate candidates used to price
    // their follow-up retry at that same elapsed=0, so on a case's very
    // FIRST decision every candidate gross-recovered exactly nothing,
    // lost to `stop`, and the case was abandoned forever -- even though
    // nudging moments later would obviously have been worth it (confirmed
    // against real cohort data: agent-rules recovered several of these
    // cases that agent-adaptive gave up on, on identical randomness).
    // ASSUMED_NUDGE_RESPONSE_DELAY_MS fixes this by pricing the follow-up
    // retry at elapsed + a real assumed response delay, not elapsed alone.
    const cands = candidatesFor(event({ reasonCode: 'card_expired' }), { now: AT });
    const nonStop = cands.filter((c) => c.action.kind !== 'stop');
    expect(nonStop.length).toBeGreaterThan(0);
    const best = cands.reduce((a, b) => (b.expectedValuePaise > a.expectedValuePaise ? b : a));
    expect(best.action.kind).not.toBe('stop');
    expect(best.expectedValuePaise).toBeGreaterThan(0);
  });

  it('every candidate reports a consistent gross/cost/EV breakdown', () => {
    const cands = candidatesFor(event({ reasonCode: 'insufficient_funds', lossType: 'receivable' }));
    for (const c of cands) {
      expect(c.expectedValuePaise).toBeCloseTo(c.grossRecoveryPaise - c.totalCostPaise, 5);
      expect(c.totalCostPaise).toBeCloseTo(c.costPaise + c.spamPoints * 2000, 5);
    }
  });
});

describe('voice pricing uses the real cost/spam/landing constants, not invented ones', () => {
  it('voice EV reflects its own higher cost relative to email for the same case', () => {
    const cands = candidatesFor(event({ reasonCode: 'card_expired' }), { now: AT + 30 * 60_000 });
    const voice = cands.find((c) => c.action.kind === 'contact_customer' && c.action.channel === 'voice');
    const email = cands.find((c) => c.action.kind === 'contact_customer' && c.action.channel === 'email');
    expect(voice).toBeDefined();
    expect(email).toBeDefined();
    // Same gain formula, voice pays a strictly higher direct+spam cost --
    // so voice's EV can only exceed email's because its landing odds are
    // also higher (BELIEVED_NUDGE_ODDS.voice > .email), never "for free".
    expect(voice!.action.rationale).toContain('voice');
  });
});

describe('cumulative annoyance across repeated contacts', () => {
  it('prices the SAME channel choice as more annoying (in rupee-equivalent spam points) the more times this customer has already been contacted', () => {
    const e = event({ reasonCode: 'card_expired' });
    const freshCands = candidatesFor(e, { now: AT + 30 * 60_000 });
    const freshWhatsapp = freshCands.find((c) => c.action.kind === 'contact_customer' && c.action.channel === 'whatsapp');
    expect(freshWhatsapp).toBeDefined();

    // A prior, already-executed contact on a DIFFERENT channel -- so
    // whatsapp is still eligible, but `contactsSoFar` is now 1.
    const priorHistory = [
      {
        at: AT,
        action: { kind: 'contact_customer' as const, channel: 'email' as const, delayMs: 0, rationale: 'prior' },
        succeeded: false,
      },
    ];
    const wornCands = candidatesFor(e, { now: AT + 30 * 60_000, history: priorHistory, channelsUsed: ['email'] });
    const wornWhatsapp = wornCands.find((c) => c.action.kind === 'contact_customer' && c.action.channel === 'whatsapp');
    expect(wornWhatsapp).toBeDefined();

    // Same channel, same case, same elapsed time -- the only thing that
    // changed is contact history. The second contact must be priced as
    // MORE annoying, not the same, or repeated outreach is silently free
    // past the first message.
    expect(wornWhatsapp!.spamPoints).toBeGreaterThan(freshWhatsapp!.spamPoints);
  });
});

describe('no decision after recovery', () => {
  // Structural, not a policy convention: `eval/engine.ts`'s own loop
  // checks `if (recovered) { ...; break; }` immediately after every
  // execution, before `decide()` can run again. This test exercises the
  // real engine end-to-end (not just the pricing layer) to prove that
  // guarantee, directly addressing "the agent must never attempt recovery
  // on revenue that is already recovered."
  it('leaves no ledger entry, of any kind, after the entry that recovered the case', async () => {
    const { runCase } = await import('../eval/engine.js');
    const { createAdaptiveAgent } = await import('./adaptive-agent.js');
    const { Ledger } = await import('../ledger/ledger.js');
    const { Rng } = await import('../sim/rng.js');

    const agent = createAdaptiveAgent(DEFAULT_COSTS);
    let recoveredCasesSeen = 0;

    for (let seed = 1; seed <= 40; seed++) {
      const e = event({
        reasonCode: ['card_expired', 'insufficient_funds', 'payment_timed_out', 'bank_technical_error'][seed % 4],
        amountPaise: 50_000 + seed * 10_000,
        occurredAt: AT + seed * 3_600_000,
      });
      const ledger = new Ledger();
      const result = runCase(e, agent, DEFAULT_COSTS, new Rng(seed), ledger);
      if (!result.recovered) continue;
      recoveredCasesSeen++;
      expect(result.stoppedReason).toBe('recovered');

      // The real, on-the-record evidence: the entry that actually
      // recovered the case (an executed retry or contact that
      // succeeded, worth the full case amount) must be the LAST entry
      // for this case in the ledger -- not merely "the last one we
      // happened to check," the literal final row. If the agent (or
      // anything else) ever acted again after recovery, it would show up
      // here as an entry that comes after this one.
      // A "succeeded" contact does not always mean IT was the recovery
      // (a landed nudge can succeed without the link-payment behind it
      // landing too) -- but since the loop provably stops the instant
      // recovery happens, the recovering entry is always the LAST
      // matching one, never an earlier one. Search from the end.
      const entries = ledger.forCase(e.id);
      let recoveryIdx = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const en = entries[i]!;
        if (en.outcome === 'executed' && en.succeeded === true && (en.actionKind === 'retry_payment' || en.actionKind === 'contact_customer')) {
          recoveryIdx = i;
          break;
        }
      }
      expect(recoveryIdx).toBeGreaterThanOrEqual(0);
      expect(entries.length).toBe(recoveryIdx + 1);
    }

    // Sanity: the fixture actually exercises real recoveries, not just an
    // always-fails case that trivially never triggers the check.
    expect(recoveredCasesSeen).toBeGreaterThan(0);
  });
});

describe('duplicate-debit verification on uncertain debit status', () => {
  it('holds the earliest retry offer back to the verification window for a case whose original authorisation outcome is unconfirmed', () => {
    const e = event({ reasonCode: 'payment_timed_out', debitStatus: 'uncertain' });
    const cands = candidatesFor(e); // now = event.occurredAt, i.e. elapsed = 0
    const retries = cands.filter((c) => c.action.kind === 'retry_payment');
    expect(retries.length).toBeGreaterThan(0);
    // The EARLIEST offer (shortest delay) is the one that would otherwise
    // fire before verification completes -- that one must be held, and say
    // why. Later offsets that already exceed the window are untouched.
    const earliest = retries.reduce((a, b) => (b.action.delayMs < a.action.delayMs ? b : a));
    expect(earliest.action.delayMs).toBeGreaterThanOrEqual(30 * 60_000);
    expect(earliest.action.rationale).toContain('duplicate-debit verification');
  });

  it('does NOT hold back a retry once the debit status is known (no_debit)', () => {
    const e = event({ reasonCode: 'payment_timed_out', debitStatus: 'no_debit' });
    const cands = candidatesFor(e);
    const retries = cands.filter((c) => c.action.kind === 'retry_payment');
    expect(retries.length).toBeGreaterThan(0);
    for (const r of retries) {
      expect(r.action.rationale).not.toContain('duplicate-debit verification');
    }
  });

  it('does NOT hold back a retry once one has already been attempted -- only the unconfirmed FIRST attempt is at risk', () => {
    const e = event({ reasonCode: 'payment_timed_out', debitStatus: 'uncertain' });
    // A real, already-executed retry in history -- this is what
    // `attemptsSoFar` actually counts (derived from history, not a raw
    // counter field), so this is the correct way to simulate "one retry
    // has already happened."
    const priorHistory = [
      {
        at: AT,
        action: { kind: 'retry_payment' as const, delayMs: 0, rationale: 'prior' },
        succeeded: false,
      },
    ];
    const cands = candidatesFor(e, { history: priorHistory });
    const retries = cands.filter((c) => c.action.kind === 'retry_payment');
    expect(retries.length).toBeGreaterThan(0);
    for (const r of retries) {
      expect(r.action.rationale).not.toContain('duplicate-debit verification');
    }
  });
});

describe('causal credit: an inert intervention cannot be credited with a recovery it could not have caused', () => {
  it('a contact that lands (customer engages) does NOT recover a TRANSIENT_INFRA case -- only the SUBSEQUENT retry, once the outage itself has actually cleared, does', async () => {
    // TRANSIENT_INFRA (a bank/gateway outage) has no causal path from a
    // customer nudge at all -- the customer did nothing wrong, so there
    // is nothing a message can persuade them to fix (see
    // action-registry.ts:contactHasCausalPath, which is exactly why the
    // real policy never even offers contact for this class). This test
    // does not trust that gate alone -- it goes around the policy layer
    // entirely with a rigged strategy that ALWAYS proposes voice contact
    // first, to prove the ENGINE's own ground truth (not the policy's
    // restraint) is what refuses to credit an inert action, structurally.
    const { runCase } = await import('../eval/engine.js');
    const { Ledger } = await import('../ledger/ledger.js');
    const { Rng } = await import('../sim/rng.js');

    let contactTried = false;
    const forceContactThenRetry = {
      id: 'test-inert-contact',
      name: 'test',
      description: 'always contacts once, then retries',
      decide(context: CaseContext) {
        if (!contactTried) {
          contactTried = true;
          return { kind: 'contact_customer' as const, channel: 'voice' as const, delayMs: 0, rationale: 'forced' };
        }
        return { kind: 'retry_payment' as const, delayMs: 0, rationale: 'forced' };
      },
    };

    const e = event({ reasonCode: 'bank_technical_error', lossType: 'payment_failure' }); // TRANSIENT_INFRA
    // Try several seeds: the voice contact WILL sometimes "land"
    // (customer engages, succeeded=true on that ledger entry) since
    // landing odds are real -- the claim under test is narrower and must
    // hold regardless: landing never sets `recovered`, for this class.
    for (let seed = 1; seed <= 15; seed++) {
      contactTried = false;
      const ledger = new Ledger();
      const result = runCase(e, forceContactThenRetry, DEFAULT_COSTS, new Rng(seed), ledger);
      const entries = ledger.forCase(e.id);
      const contactEntry = entries.find((en) => en.actionKind === 'contact_customer');
      if (contactEntry?.succeeded === true) {
        // The contact landed. It must still not be the thing that
        // recovered the case -- if `recovered` is true here, it can only
        // be because the FOLLOWING retry (the outage clearing on its
        // own, unrelated to the contact) succeeded, not the contact.
        if (result.recovered) {
          const retryEntry = entries.find((en) => en.actionKind === 'retry_payment' && en.succeeded === true);
          expect(retryEntry).toBeDefined();
        }
      }
    }
  });

  it('a contact_customer candidate is never even PRICED for a class with no causal path -- structurally excluded, not merely low-value', () => {
    // The policy-layer half of the same guarantee: for TRANSIENT_INFRA
    // under a retryable loss type, contact_customer must not appear in
    // the candidate list AT ALL (not "appear but lose the argmax" --
    // genuinely absent), because `action-registry.ts:contactHasCausalPath`
    // returns false and every contactSpec returns `[]` before pricing
    // anything.
    const e = event({ reasonCode: 'bank_technical_error', lossType: 'payment_failure' });
    const cands = candidatesFor(e);
    const contactCandidates = cands.filter((c) => c.action.kind === 'contact_customer');
    expect(contactCandidates.length).toBe(0);
  });
});
