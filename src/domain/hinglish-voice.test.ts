import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { hinglishTranscriptFor, INTENT_LABEL_HINGLISH } from './hinglish-voice.js';

const ALL_SIGNAL_KINDS = [
  'promise_to_pay',
  'funds_available_now',
  'instrument_fixed',
  'disputes_charge',
  'refused',
  'no_answer',
] as const;

describe('Hinglish voice transcript: presentation only, never a second decision path', () => {
  it('has a mapping for every real CustomerSignal kind -- none fall through to a generic default', () => {
    for (const kind of ALL_SIGNAL_KINDS) {
      const lines = hinglishTranscriptFor({ kind } as never);
      expect(lines.length).toBeGreaterThan(0);
      expect(INTENT_LABEL_HINGLISH[kind]).toBeTruthy();
    }
  });

  it('is a pure function of the signal kind alone: same input, same output, every time', () => {
    for (const kind of ALL_SIGNAL_KINDS) {
      const a = hinglishTranscriptFor({ kind } as never);
      const b = hinglishTranscriptFor({ kind } as never);
      expect(a).toEqual(b);
    }
  });

  it('no_answer produces no fabricated customer dialogue -- honest about there being no conversation', () => {
    const lines = hinglishTranscriptFor({ kind: 'no_answer' } as never);
    const customerLine = lines.find((l) => l.speaker === 'customer');
    expect(customerLine?.hinglish).toContain('not answered');
  });

  // The structural guarantee this whole feature depends on: nothing in the
  // decision-making layer (policies/, guardrails/, eval/engine.ts) may
  // import this file. If it ever did, "Hinglish voice" would have quietly
  // become a second, hidden decision path instead of a rendering of the
  // one the agent already uses -- exactly the failure mode the OOD/
  // causal-credit audits earlier in this project exist to catch.
  it('is never imported by any policy, guardrail, or engine file -- a real check of the source, not a design promise', async () => {
    const filesToCheck = [
      '../policies/adaptive-agent.ts',
      '../policies/action-registry.ts',
      '../policies/case-state.ts',
      '../policies/assessment.ts',
      '../policies/rules-agent.ts',
      '../guardrails/index.ts',
      '../guardrails/limits.ts',
      '../guardrails/compliance.ts',
      '../eval/engine.ts',
      '../eval/metrics.ts',
      '../sim/voice-signal-model.ts',
      '../sim/recovery-model.ts',
    ];
    for (const rel of filesToCheck) {
      const src = await readFile(new URL(rel, import.meta.url), 'utf8');
      expect(src.includes('hinglish-voice')).toBe(false);
    }
  });
});
