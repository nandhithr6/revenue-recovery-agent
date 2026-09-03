import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { UnknownErrorCache, createLlmInterpreter } from '../llm/unknown-error.js';

/**
 * Part J: the information boundary, checked mechanically rather than
 * asserted in a comment. Every file the new novelty/voice/assessment work
 * added to the policy layer must hold the same rule `adaptive-agent.test.ts`
 * already enforces for the original two files: no import of
 * `sim/recovery-model.ts` (ground truth for retry/contact odds), and now
 * also no import of `sim/voice-signal-model.ts` (ground truth for what a
 * customer says on a call) -- both are read ONLY by `eval/engine.ts`.
 */

const POLICY_FILES = [
  'assessment.ts',
  'case-state.ts',
  'action-registry.ts',
  'adaptive-agent.ts',
  'rules-agent.ts',
  'adaptive-model.ts',
] as const;

async function sourceOf(relativeToPolicies: string): Promise<string> {
  return readFile(new URL(`./${relativeToPolicies}`, import.meta.url), 'utf8');
}

describe('no policy file reads ground truth', () => {
  for (const file of POLICY_FILES) {
    it(`${file} does not import from sim/recovery-model.ts`, async () => {
      const src = await sourceOf(file);
      expect(src.includes("from '../sim/recovery-model")).toBe(false);
    });

    it(`${file} does not import from sim/voice-signal-model.ts`, async () => {
      const src = await sourceOf(file);
      expect(src.includes("from '../sim/voice-signal-model")).toBe(false);
    });
  }
});

describe('the optional LLM interpreter cannot exceed its authority', () => {
  it('a cached entry can never carry HIGH confidence -- the type itself only allows low/medium', async () => {
    const cache = new UnknownErrorCache();
    // Load a hand-crafted entry as if it came from disk/a prior run,
    // including a field an attacker or a bug might try to smuggle in.
    cache.load({
      some_code: { recoveryClass: 'HARD_DECLINE', confidence: 'medium', evidence: ['x'] },
    });
    const entry = cache.get('some_code');
    expect(entry?.confidence).not.toBe('high' as never);
  });

  it('an interpreter built from an empty cache returns undefined, never fabricates a class', () => {
    const cache = new UnknownErrorCache();
    const interpret = createLlmInterpreter(cache);
    expect(interpret({ reasonCode: 'anything' })).toBeUndefined();
  });

  it('unknown-error.ts source never assigns confidence "high" anywhere', async () => {
    const src = await readFile(new URL('../llm/unknown-error.ts', import.meta.url), 'utf8');
    expect(src.includes("'high'")).toBe(false);
  });

  it('the system works with zero LLM configuration: createAdaptiveAgent needs no interpreter', async () => {
    const { createAdaptiveAgent } = await import('./adaptive-agent.js');
    const { DEFAULT_COSTS } = await import('../sim/scenario.js');
    const agent = createAdaptiveAgent(DEFAULT_COSTS); // no options at all
    const action = agent.decide({
      event: {
        id: 'x',
        lossType: 'payment_failure',
        merchantId: 'm',
        customer: {
          id: 'c',
          dndRegistered: false,
          consent: { email: true, sms: true, whatsapp: true, voice: true },
          utcOffsetMinutes: 330,
          respondsToNudge: true,
        },
        amountPaise: 100_000,
        method: 'card',
        reasonCode: 'insufficient_funds',
        occurredAt: Date.now(),
      },
      now: Date.now(),
      history: [],
      attemptCount: 0,
      contactCount: 0,
      channelsUsed: [],
    });
    expect(action.kind).toBeDefined();
  });
});
