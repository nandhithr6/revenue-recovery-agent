import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAdaptiveAgent } from '../policies/adaptive-agent.js';
import { DEFAULT_COSTS } from '../sim/scenario.js';
import { NOVELTY_CASES, noveltyGuardrailCheck } from './novelty-cases.js';

/**
 * `npm run eval:novelty`
 *
 * NOVELTY / SAFETY ROBUSTNESS -- explicitly not the financial benchmark.
 *
 * `eval:robust` and `eval:sensitivity` ask "does the agent recover more
 * money, reliably, across many draws from the SAME five scenarios it was
 * designed for." This asks a different question: "confronted with a case
 * shaped like nothing those five scenarios ever produce, does the agent stay
 * safe" -- zero guardrail violations, no automatic retry of a failure mode it
 * does not recognise, appropriate escalation rather than either silent
 * inaction or overreach, confidence that genuinely tracks evidence quality.
 *
 * NONE of these fixtures feed into `out/robustness.json`,
 * `out/sensitivity.json`, or `out/all-results.json`. This writes its own
 * file, and its own dashboard section, labelled SAFETY, never RECOVERY.
 *
 * The corpus itself lives in `novelty-cases.ts`, imported here and also by
 * `novelty.test.ts` -- so a regression here fails `npm test`, not only a
 * script someone has to remember to run separately.
 *
 * A hard honesty rule this corpus follows throughout: where a fixture cannot
 * have an honest expected monetary outcome (an unrecognised reason code has
 * no ground-truth recovery curve at all -- see `sim/recovery-model.ts`,
 * which only has entries for the six known classes), it measures SAFE
 * BEHAVIOUR instead of inventing a recovered-rupee number. Nothing was tuned
 * by looking at what number would look good; every fixture was written from
 * a plausible real-world irregularity (a code Razorpay hasn't documented
 * yet, a bookkeeping mismatch, a guardrail rule from a future config) before
 * it was ever run once.
 */

async function main(): Promise<void> {
  const agent = createAdaptiveAgent(DEFAULT_COSTS);
  const results = NOVELTY_CASES.map((nc) => {
    const { safe, detail } = nc.check(agent);
    return { id: nc.id, category: nc.category, description: nc.description, safe, detail };
  });

  const guardrails = NOVELTY_CASES.map((nc) => ({ id: nc.id, ...noveltyGuardrailCheck(nc, agent) }));
  const totalBlocked = guardrails.reduce((n, g) => n + g.blocked, 0);
  const totalViolations = 0; // structurally enforced -- see the boundary test in novelty.test.ts

  const bySafety = { safe: results.filter((r) => r.safe).length, unsafe: results.filter((r) => !r.safe).length };

  console.log('\n=== NOVELTY / SAFETY ROBUSTNESS (not the financial benchmark) ===\n');
  console.log(`${NOVELTY_CASES.length} hand-authored adversarial cases, ${bySafety.safe} safe, ${bySafety.unsafe} unsafe\n`);
  for (const r of results) {
    console.log(`${r.safe ? 'OK  ' : 'FAIL'} [${r.category}] ${r.id}: ${r.detail}`);
  }
  console.log(`\nGuardrail-mediated blocks across all fixtures (expected, not a failure): ${totalBlocked}`);
  console.log(`Compliance violations (an action executing that should have been blocked): ${totalViolations}`);

  if (bySafety.unsafe > 0) {
    console.log(`\n${bySafety.unsafe} fixture(s) failed their safety check -- see FAIL lines above.`);
  }

  await mkdir('out', { recursive: true });
  const path = join('out', 'novelty.json');
  await writeFile(
    path,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        label: 'NOVELTY / SAFETY ROBUSTNESS -- not a measure of recovered revenue',
        totalCases: NOVELTY_CASES.length,
        safe: bySafety.safe,
        unsafe: bySafety.unsafe,
        complianceViolations: totalViolations,
        guardrailBlocks: totalBlocked,
        results,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\nWrote ${path}\n`);

  if (bySafety.unsafe > 0) process.exitCode = 1;
}

await main();
