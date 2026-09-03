import { describe, expect, it } from 'vitest';
import type { CustomerProfile, LossEvent } from '../domain/types.js';
import { assess, assessmentChanged, deterministicFallback } from './assessment.js';
import type { CaseContext } from './types.js';

const AT = Date.parse('2026-09-01T11:00:00+05:30');

const customer = (over: Partial<CustomerProfile> = {}): CustomerProfile => ({
  id: 'cust_assess',
  dndRegistered: false,
  consent: { email: true, sms: true, whatsapp: true, voice: true },
  utcOffsetMinutes: 330,
  respondsToNudge: true,
  ...over,
});

const event = (over: Partial<LossEvent> = {}): LossEvent => ({
  id: 'loss_assess',
  lossType: 'payment_failure',
  merchantId: 'merch_001',
  customer: customer(),
  amountPaise: 100_000,
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

describe('assess: known cases', () => {
  it('a documented reason code with no anomalies is known/high', () => {
    const a = assess(ctx(event({ reasonCode: 'insufficient_funds' })));
    expect(a.status).toBe('known');
    expect(a.confidence).toBe('high');
    expect(a.recoveryClass).toBe('TRANSIENT_FUNDS');
    expect(a.anomalies).toHaveLength(0);
  });

  it('a documented code with a context anomaly is known but only medium', () => {
    const a = assess(ctx(event({ reasonCode: 'insufficient_funds' }), { attemptCount: 3 }));
    expect(a.status).toBe('known');
    expect(a.confidence).toBe('medium');
    expect(a.anomalies.length).toBeGreaterThan(0);
  });

  it('checkout_abandonment with no reason code is inferred as ABANDONMENT, not unknown', () => {
    const a = assess(ctx(event({ reasonCode: undefined, lossType: 'checkout_abandonment' })));
    expect(a.status).toBe('inferred');
    expect(a.recoveryClass).toBe('ABANDONMENT');
    expect(a.confidence).not.toBe('high');
  });

  it('no reason code on a loss type that does not imply abandonment is genuinely unknown', () => {
    const a = assess(ctx(event({ reasonCode: undefined, lossType: 'payment_failure' })));
    expect(a.status).toBe('unknown');
    expect(a.recoveryClass).toBeUndefined();
    expect(a.confidence).toBe('low');
  });
});

describe('assess: unknown and inferred cases never reach HIGH confidence', () => {
  it('a reason code sharing no vocabulary with anything documented is unknown/low', () => {
    const a = assess(ctx(event({ reasonCode: 'zzz_totally_novel_9182' })));
    expect(a.status).toBe('unknown');
    expect(a.confidence).toBe('low');
    expect(a.recoveryClass).toBeUndefined();
  });

  it('a close token match is inferred at MEDIUM at best, never HIGH', () => {
    const a = assess(ctx(event({ reasonCode: 'card_expiry_lapsed' }))); // close to "card_expired"
    expect(a.confidence).not.toBe('high');
    if (a.status === 'inferred') expect(a.confidence).toBe('medium');
  });

  it('an external interpreter cannot promote a guess above MEDIUM even with zero anomalies', () => {
    const a = assess(ctx(event({ reasonCode: 'made_up_code' })), () => ({
      recoveryClass: 'HARD_DECLINE',
      confidence: 'medium',
      evidence: ['fake interpreter'],
    }));
    expect(a.status).toBe('inferred');
    expect(a.confidence).toBe('medium');
    expect(a.confidence).not.toBe('high');
  });

  it('an external interpreter that finds nothing falls through to unknown, not a crash', () => {
    const a = assess(ctx(event({ reasonCode: 'made_up_code' })), () => undefined);
    expect(['unknown', 'inferred']).toContain(a.status); // falls back to deterministic matcher
  });
});

describe('assess: anomaly detection', () => {
  it('flags a non-positive amount', () => {
    const a = assess(ctx(event({ amountPaise: 0 })));
    expect(a.anomalies.some((x) => x.includes('non-positive'))).toBe(true);
  });

  it('flags attemptCount not matching executed retry history', () => {
    const a = assess(ctx(event(), { attemptCount: 4, history: [] }));
    expect(a.anomalies.some((x) => x.includes('attemptCount'))).toBe(true);
  });

  it('flags contactCount not matching executed contact history', () => {
    const a = assess(ctx(event(), { contactCount: 2, history: [] }));
    expect(a.anomalies.some((x) => x.includes('contactCount'))).toBe(true);
  });

  it('does not flag consistent attempt/contact counts', () => {
    const history = [
      { at: AT, action: { kind: 'retry_payment' as const, delayMs: 0, rationale: 'x' }, succeeded: false },
    ];
    const a = assess(ctx(event(), { attemptCount: 1, contactCount: 0, history }));
    expect(a.anomalies).toHaveLength(0);
  });
});

describe('deterministicFallback: fuzzy string matching, honestly documented as such', () => {
  it('never returns HIGH confidence', () => {
    const r1 = deterministicFallback('insufficient_fundss'); // near-exact
    const r2 = deterministicFallback('totally_unrelated_gibberish_xyz');
    expect(r1.confidence).not.toBe('high' as never);
    expect(r2.confidence).not.toBe('high' as never);
  });

  it('returns null for a code sharing no vocabulary with anything documented', () => {
    const r = deterministicFallback('qqqqq_zzzzz_9182');
    expect(r.recoveryClass).toBeNull();
    expect(r.confidence).toBe('low');
  });

  it('an inconsistent error source demotes an otherwise-plausible match to low/null', () => {
    const withoutSource = deterministicFallback('card_expiry_lapsed');
    const withWrongSource = deterministicFallback('card_expiry_lapsed', 'bank'); // card_expired's real source is 'customer'
    if (withoutSource.recoveryClass) {
      expect(withWrongSource.recoveryClass).toBeNull();
      expect(withWrongSource.confidence).toBe('low');
    }
  });
});

describe('assessmentChanged', () => {
  it('is false when there is no prior assessment to compare against', () => {
    const current = assess(ctx(event()));
    expect(assessmentChanged(undefined, current)).toBe(false);
  });

  it('is true when confidence changes', () => {
    const a = assess(ctx(event({ reasonCode: 'insufficient_funds' })));
    const b = assess(ctx(event({ reasonCode: 'insufficient_funds' }), { attemptCount: 3 }));
    expect(assessmentChanged(a, b)).toBe(true);
  });

  it('is false when nothing material differs', () => {
    const a = assess(ctx(event({ reasonCode: 'insufficient_funds' })));
    const b = assess(ctx(event({ reasonCode: 'insufficient_funds' })));
    expect(assessmentChanged(a, b)).toBe(false);
  });
});
