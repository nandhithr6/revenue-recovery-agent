import { describe, expect, it } from 'vitest';
import type { CustomerProfile, CustomerSignal, LossEvent } from '../domain/types.js';
import { gate } from '../guardrails/index.js';
import { createAdaptiveAgent } from './adaptive-agent.js';
import { deriveState } from './case-state.js';
import { LOSS_PROFILES } from './loss-profiles.js';
import { DEFAULT_COSTS } from '../sim/scenario.js';
import type { CaseContext, HistoryEntry } from './types.js';

/**
 * Part E/F/G/H of the design review: voice as a genuinely priced channel,
 * a structured customer signal instead of a plain boolean, and the
 * replanning that follows from it -- all going through the SAME unmodified
 * guardrail gate every other channel does.
 */

const AT = Date.parse('2026-09-01T11:00:00+05:30');
const agent = createAdaptiveAgent(DEFAULT_COSTS);

const customer = (over: Partial<CustomerProfile> = {}): CustomerProfile => ({
  id: 'cust_voice',
  dndRegistered: false,
  consent: { email: true, sms: true, whatsapp: true, voice: true },
  utcOffsetMinutes: 330,
  respondsToNudge: true,
  ...over,
});

const event = (over: Partial<LossEvent> = {}): LossEvent => ({
  id: 'loss_voice',
  lossType: 'payment_failure',
  merchantId: 'merch_001',
  customer: customer(),
  amountPaise: 5_000_000,
  method: 'card',
  reasonCode: 'insufficient_funds',
  occurredAt: AT,
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

function voiceHistory(signal: CustomerSignal, at: number = AT): HistoryEntry[] {
  return [
    {
      at,
      action: { kind: 'contact_customer', channel: 'voice', delayMs: 0, rationale: 'x' },
      succeeded: signal.kind === 'promise_to_pay' || signal.kind === 'funds_available_now' || signal.kind === 'instrument_fixed',
      signal,
    },
  ];
}

describe('guardrails gate voice identically to every other channel', () => {
  it('a DND-registered customer blocks voice, same as SMS', () => {
    const verdict = gate({
      action: { kind: 'contact_customer', channel: 'voice', delayMs: 0, rationale: 'x' },
      customer: customer({ dndRegistered: true }),
      at: AT,
      caseOpenedAt: AT,
      history: [],
    });
    expect(verdict.kind).toBe('block');
    if (verdict.kind === 'block') expect(verdict.rule).toBe('DND_REGISTERED');
  });

  it('no consent for voice blocks it', () => {
    const verdict = gate({
      action: { kind: 'contact_customer', channel: 'voice', delayMs: 0, rationale: 'x' },
      customer: customer({ consent: { email: true, sms: true, whatsapp: true, voice: false } }),
      at: AT,
      caseOpenedAt: AT,
      history: [],
    });
    expect(verdict.kind).toBe('block');
    if (verdict.kind === 'block') expect(verdict.rule).toBe('NO_CONSENT');
  });

  it('quiet hours defer a voice call, same as any contact', () => {
    // 22:00 local (utcOffsetMinutes 330 = IST) is inside quiet hours (21:00-09:00).
    const quietAt = Date.parse('2026-09-01T22:00:00+05:30');
    const verdict = gate({
      action: { kind: 'contact_customer', channel: 'voice', delayMs: 0, rationale: 'x' },
      customer: customer(),
      at: quietAt,
      caseOpenedAt: AT,
      history: [],
    });
    expect(verdict.kind).toBe('defer');
    if (verdict.kind === 'defer') expect(verdict.rule).toBe('QUIET_HOURS');
  });

  it('the policy never proposes voice for a customer who has not consented to it', () => {
    const e = event({ customer: customer({ consent: { email: true, sms: true, whatsapp: true, voice: false } }) });
    // Run several steps; voice must never appear regardless of how the case evolves.
    let context = ctx(e);
    for (let i = 0; i < 5; i++) {
      const action = agent.decide(context);
      expect(action.channel).not.toBe('voice');
      if (action.kind === 'stop') break;
      context = { ...context, history: [...context.history, { at: context.now, action, succeeded: false }] };
    }
  });
});

describe('structured voice signals change the next decision', () => {
  it('promise_to_pay waits, not stops or retries immediately', () => {
    const e = event({ lossType: 'payment_failure' });
    const action = agent.decide(
      ctx(e, { now: AT + 60_000, history: voiceHistory({ kind: 'promise_to_pay' }), contactCount: 1, channelsUsed: ['voice'] }),
    );
    expect(action.kind).toBe('wait');
  });

  it('a lapsed promise_to_pay window falls through to a real retry, not an infinite wait', () => {
    const e = event({ lossType: 'payment_failure' });
    const twoDaysLater = AT + 3 * 24 * 60 * 60_000;
    const action = agent.decide(
      ctx(e, {
        now: twoDaysLater,
        history: voiceHistory({ kind: 'promise_to_pay' }),
        contactCount: 1,
        channelsUsed: ['voice'],
      }),
    );
    expect(action.kind).not.toBe('wait');
  });

  it('disputes_charge stops the case rather than trying another channel', () => {
    const e = event({ lossType: 'payment_failure' });
    const action = agent.decide(
      ctx(e, { now: AT + 60_000, history: voiceHistory({ kind: 'disputes_charge' }), contactCount: 1, channelsUsed: ['voice'] }),
    );
    expect(action.kind).toBe('stop');
  });

  it('refused stops the case rather than trying another channel', () => {
    const e = event({ lossType: 'payment_failure' });
    const action = agent.decide(
      ctx(e, { now: AT + 60_000, history: voiceHistory({ kind: 'refused' }), contactCount: 1, channelsUsed: ['voice'] }),
    );
    expect(action.kind).toBe('stop');
  });

  it('funds_available_now flips state.customerActed, which is what unlocks the immediate-retry pricing', () => {
    // Whether the immediate retry wins the overall argmax also depends on
    // amount/floor thresholds unrelated to this mechanism -- what THIS test
    // isolates is the actual state transition the signal causes.
    const e = event({ reasonCode: 'insufficient_funds' });
    const context = ctx(e, { now: AT + 60_000, history: voiceHistory({ kind: 'funds_available_now' }), contactCount: 1, channelsUsed: ['voice'] });
    const state = deriveState(context, LOSS_PROFILES[e.lossType]);
    expect(state.customerActed).toBe(true);
  });

  it('instrument_fixed flips state.customerActed on a CUSTOMER_ACTION_REQUIRED case', () => {
    const e = event({ reasonCode: 'card_expired' });
    const context = ctx(e, { now: AT + 60_000, history: voiceHistory({ kind: 'instrument_fixed' }), contactCount: 1, channelsUsed: ['voice'] });
    const state = deriveState(context, LOSS_PROFILES[e.lossType]);
    expect(state.customerActed).toBe(true);
    // And that flag genuinely changes the decision here: CUSTOMER_ACTION_REQUIRED's
    // floor is 0.01 without it, so a real candidate should now be on offer.
    const action = agent.decide(context);
    expect(action.kind).not.toBe('stop');
  });

  it('no_answer fabricates no benefit -- decision proceeds as if nothing happened', () => {
    const e = event({ reasonCode: 'insufficient_funds' });
    const withSignal = agent.decide(
      ctx(e, { now: AT + 60_000, history: voiceHistory({ kind: 'no_answer' }), contactCount: 1, channelsUsed: ['voice'] }),
    );
    // Must not be treated as a positive outcome: no wait, no immediate high-confidence retry framed as "customer acted".
    expect(withSignal.rationale).not.toContain('customer acted');
    expect(withSignal.kind).not.toBe('wait');
  });
});

describe('replanning is genuine engine behaviour, not a scripted sequence', () => {
  it('the SAME decide() function produces different next actions for different signals on an otherwise-identical case', () => {
    const e = event({ reasonCode: 'insufficient_funds' });
    const base = { now: AT + 60_000, contactCount: 1, channelsUsed: ['voice'] as const };
    const promise = agent.decide(ctx(e, { ...base, history: voiceHistory({ kind: 'promise_to_pay' }) }));
    const disputes = agent.decide(ctx(e, { ...base, history: voiceHistory({ kind: 'disputes_charge' }) }));
    const fundsNow = agent.decide(ctx(e, { ...base, history: voiceHistory({ kind: 'funds_available_now' }) }));
    const noAnswer = agent.decide(ctx(e, { ...base, history: voiceHistory({ kind: 'no_answer' }) }));

    const kinds = new Set([promise.kind, disputes.kind, fundsNow.kind, noAnswer.kind]);
    // At least three distinct action kinds across four distinct signals --
    // proof the branching is driven by the signal, not a coincidence.
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });
});
