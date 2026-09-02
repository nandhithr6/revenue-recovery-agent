import { describe, expect, it } from 'vitest';
import { DAY, HOUR, type CustomerProfile, type LossEvent, type LossType } from '../domain/types.js';
import { runCase } from '../eval/engine.js';
import { DEFAULT_LIMITS } from '../guardrails/limits.js';
import { Ledger } from '../ledger/ledger.js';
import { Rng } from '../sim/rng.js';
import { DEFAULT_COSTS } from '../sim/scenario.js';
import { LOSS_PROFILES } from './loss-profiles.js';
import { createRulesAgent } from './rules-agent.js';
import { BASELINE_STRATEGIES } from './baselines.js';
import type { CaseContext, HistoryEntry } from './types.js';

/**
 * The loss-type layer decides what recovery is even PERMITTED, which is
 * independent of what the failure reason makes advisable.
 *
 * This is the newest and most intricate part of the policy, and it is the part
 * that broke every result once already (engineering log, entry 7). It had no
 * tests until now.
 */

const agent = createRulesAgent(DEFAULT_COSTS);
const AT = Date.parse('2026-09-01T11:00:00+05:30');

const customer = (over: Partial<CustomerProfile> = {}): CustomerProfile => ({
  id: 'cust_lp',
  dndRegistered: false,
  consent: { email: true, sms: true, whatsapp: true, voice: true },
  utcOffsetMinutes: 330,
  respondsToNudge: true,
  ...over,
});

const event = (lossType: LossType, over: Partial<LossEvent> = {}): LossEvent => ({
  id: `loss_${lossType}`,
  lossType,
  merchantId: 'merch_001',
  customer: customer(),
  amountPaise: 400_000, // Rs 4,000 - large enough to clear the EV gate
  method: 'card',
  reasonCode: 'insufficient_funds',
  occurredAt: AT,
  ...over,
});

const run = (e: LossEvent, seed = 11) =>
  runCase(e, agent, DEFAULT_COSTS, new Rng(seed), new Ledger());

const ctx = (e: LossEvent, over: Partial<CaseContext> = {}): CaseContext => ({
  event: e,
  now: e.occurredAt,
  history: [],
  attemptCount: 0,
  contactCount: 0,
  channelsUsed: [],
  ...over,
});

describe('checkout abandonment', () => {
  it('never re-attempts a charge nobody authorised', () => {
    // The customer left before authorising anything. "Retrying" would be
    // charging someone who never agreed to pay.
    const result = run(event('checkout_abandonment', { reasonCode: 'payment_cancelled' }));
    expect(result.retries).toBe(0);
  });

  it('recovers through contact instead', () => {
    const result = run(event('checkout_abandonment', { reasonCode: 'payment_cancelled' }));
    expect(result.contacts).toBeGreaterThan(0);
  });

  it('is declared non-retryable in the profile', () => {
    expect(LOSS_PROFILES.checkout_abandonment.canRetryCharge).toBe(false);
  });
});

describe('B2B receivables', () => {
  it('never retries: an invoice is not an instrument', () => {
    const result = run(event('receivable', { amountPaise: 5_000_000 }));
    expect(result.retries).toBe(0);
  });

  it('honours a promise to pay instead of chasing again immediately', () => {
    // A landed contact is a commitment. Chasing inside the window is rude and
    // ineffective; the agent should stand down until it lapses.
    const e = event('receivable', { amountPaise: 5_000_000 });
    const landedAt = AT + 2 * HOUR;
    const action = agent.decide(
      ctx(e, {
        now: landedAt + 1 * DAY,
        contactCount: 1,
        channelsUsed: ['email'],
        history: [
          {
            at: landedAt,
            action: { kind: 'contact_customer', channel: 'email', delayMs: 0, rationale: 'chase' },
            succeeded: true,
          },
        ],
      }),
    );
    expect(action.kind).toBe('stop');
    expect(action.rationale).toContain('commitment');
  });

  it('chases again once the promise window lapses', () => {
    const e = event('receivable', { amountPaise: 5_000_000 });
    const landedAt = AT + 2 * HOUR;
    const past = LOSS_PROFILES.receivable.promiseWindowMs + 1 * HOUR;
    const action = agent.decide(
      ctx(e, {
        now: landedAt + past,
        contactCount: 1,
        channelsUsed: ['email'],
        history: [
          {
            at: landedAt,
            action: { kind: 'contact_customer', channel: 'email', delayMs: 0, rationale: 'chase' },
            succeeded: true,
          },
        ],
      }),
    );
    expect(action.kind).not.toBe('stop');
  });

  it('tracks promises only for receivables', () => {
    expect(LOSS_PROFILES.receivable.tracksPromiseToPay).toBe(true);
    expect(LOSS_PROFILES.payment_failure.tracksPromiseToPay).toBe(false);
    expect(LOSS_PROFILES.checkout_abandonment.tracksPromiseToPay).toBe(false);
    expect(LOSS_PROFILES.subscription_mandate.tracksPromiseToPay).toBe(false);
  });
});

describe('subscription mandates', () => {
  it('gets more attempts than a one-off payment failure', () => {
    const mandate = run(event('subscription_mandate'));
    const oneOff = run(event('payment_failure'));
    expect(mandate.retries).toBeGreaterThan(oneOff.retries);
  });

  it('spaces the first retry further out than a one-off', () => {
    // A standing mandate means an ongoing relationship. Patience beats pressure.
    const mandate = agent.decide(ctx(event('subscription_mandate')));
    const oneOff = agent.decide(ctx(event('payment_failure')));
    expect(mandate.kind).toBe('retry_payment');
    expect(mandate.delayMs).toBeGreaterThan(oneOff.delayMs);
  });

  it('never schedules an attempt the case-age limit would refuse', () => {
    // This exact bug shipped once: retryDelayScale was compounded, pushing the
    // last mandate attempt past three weeks against a ten-day case-age limit.
    // Every proposed retry is walked here to prove the schedule stays inside it.
    const e = event('subscription_mandate');
    const history: HistoryEntry[] = [];
    let now = e.occurredAt;

    for (let step = 0; step < 12; step++) {
      const action = agent.decide(
        ctx(e, { now, history, attemptCount: history.length }),
      );
      if (action.kind !== 'retry_payment') break;
      now += action.delayMs;
      expect(now - e.occurredAt).toBeLessThanOrEqual(DEFAULT_LIMITS.maxCaseAgeMs);
      history.push({ at: now, action, succeeded: false });
    }
    expect(history.length).toBeGreaterThan(0);
  });
});

describe('ground truth applies to every strategy, not just the agent', () => {
  // The bug that made the baselines look good: the engine rewarded them for
  // "retrying" losses nobody had authorised. Ground truth must be symmetric or
  // the comparison is rigged in whichever direction the modeller prefers.
  for (const lossType of ['checkout_abandonment', 'receivable'] as const) {
    for (const strategy of BASELINE_STRATEGIES) {
      it(`${strategy.id} recovers nothing by retrying a ${lossType}`, () => {
        const e = event(lossType, { reasonCode: 'payment_cancelled', customer: customer({ consent: { email: false, sms: false, whatsapp: false, voice: false } }) });
        const result = runCase(e, strategy, DEFAULT_COSTS, new Rng(3), new Ledger());
        // With every channel refused, contact cannot recover it either, so any
        // recovery could only have come from an unauthorised retry.
        expect(result.recovered).toBe(false);
      });
    }
  }
});

describe('profile coverage', () => {
  it('defines a profile for every loss type the simulator can emit', () => {
    const types: LossType[] = [
      'payment_failure',
      'checkout_abandonment',
      'subscription_mandate',
      'receivable',
    ];
    for (const t of types) {
      expect(LOSS_PROFILES[t]).toBeDefined();
      expect(LOSS_PROFILES[t].reasoning.length).toBeGreaterThan(30);
    }
  });
});

describe('a loss type may extend a retry schedule, never conjure one', () => {
  // Regression: `extraRetries` on the mandate profile fell back to a one-day
  // anchor when the class schedule was empty, manufacturing attempts against
  // hard declines. An empty class schedule is the playbook's strongest
  // statement -- retrying this can never work -- and no loss type may override
  // it. A fraud-flagged card stays fraud-flagged whether the loss is a one-off
  // charge or a subscription.
  const neverRetryable = [
    { reasonCode: 'payment_risk_check_failed', label: 'HARD_DECLINE' },
    { reasonCode: 'card_expired', label: 'CUSTOMER_ACTION_REQUIRED' },
  ] as const;

  for (const { reasonCode, label } of neverRetryable) {
    for (const lossType of ['payment_failure', 'subscription_mandate'] as const) {
      it(`${label} on a ${lossType} proposes no retry`, () => {
        const action = agent.decide(ctx(event(lossType, { reasonCode })));
        expect(action.kind).not.toBe('retry_payment');
      });
    }
  }

  it('a subscription mandate still gets extra retries where the class allows any', () => {
    // The guard must not neuter the mandate sequencer on classes that ARE
    // retryable, or it would trade one bug for another.
    const mandate = run(event('subscription_mandate', { reasonCode: 'insufficient_funds' }));
    const oneOff = run(event('payment_failure', { reasonCode: 'insufficient_funds' }));
    expect(mandate.retries).toBeGreaterThan(oneOff.retries);
  });
});
