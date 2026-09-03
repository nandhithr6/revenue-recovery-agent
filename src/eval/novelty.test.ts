import { describe, expect, it } from 'vitest';
import { createAdaptiveAgent } from '../policies/adaptive-agent.js';
import { DEFAULT_COSTS } from '../sim/scenario.js';
import { NOVELTY_CASES, noveltyGuardrailCheck } from './novelty-cases.js';

/**
 * Runs the novelty/safety corpus as part of `npm test`, not only via
 * `npm run eval:novelty`. A regression here is a safety regression, and
 * should fail CI the same way a broken guardrail test would -- it should
 * not depend on someone remembering to run the standalone script.
 */

const agent = createAdaptiveAgent(DEFAULT_COSTS);

describe('novelty/safety corpus', () => {
  for (const nc of NOVELTY_CASES) {
    it(`[${nc.category}] ${nc.id}: ${nc.description}`, () => {
      const { safe, detail } = nc.check(agent);
      expect(safe, detail).toBe(true);
    });
  }

  it('produces zero compliance violations on every fixture, through the full guarded engine', () => {
    for (const nc of NOVELTY_CASES) {
      // Not asserting on `blocked` -- a guardrail intervening is a normal,
      // healthy outcome on adversarial fixtures, not a failure. What must
      // never happen is the engine throwing or a violation slipping through,
      // and `noveltyGuardrailCheck` running to completion without either is
      // itself the assertion.
      expect(() => noveltyGuardrailCheck(nc, agent)).not.toThrow();
    }
  });

  it('covers every category the design review asked for', () => {
    const categories = new Set(NOVELTY_CASES.map((nc) => nc.category));
    expect(categories.has('unknown reason code')).toBe(true);
    expect(categories.has('malformed/incomplete context')).toBe(true);
    expect(categories.has('contradictory state')).toBe(true);
    expect(categories.has('unexpected previous outcome')).toBe(true);
    expect(categories.has('previously-valid action unavailable')).toBe(true);
    expect(categories.has('unusual amount')).toBe(true);
    expect(categories.has('unfamiliar combination of valid attributes')).toBe(true);
  });
});
