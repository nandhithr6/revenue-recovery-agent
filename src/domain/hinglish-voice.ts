import type { CustomerSignal } from './types.js';

/**
 * Hinglish rendering of a voice call's outcome -- for the Razorpay track's
 * "Hinglish voice recovery" direction, built as a genuinely bounded,
 * truthful feature rather than a UI claim with nothing behind it.
 *
 * =========================== WHAT THIS IS =============================
 * A pure presentation layer over `CustomerSignal`, the SAME structured
 * outcome (`promise_to_pay`, `funds_available_now`, `instrument_fixed`,
 * `disputes_charge`, `refused`, `no_answer`) that `sim/voice-signal-model.ts`
 * already draws and that `policies/adaptive-agent.ts:explain()` already
 * reacts to -- see the English "customer said" generator this mirrors in
 * `dashboard/src/CaseInspector.tsx:SIGNAL_LABEL`. This file adds a second
 * rendering of the identical signal, in Hinglish, for the same purpose:
 * readability for a human looking at the trace. It introduces NO new
 * information, NO new decision path, and cannot change what the agent
 * does -- the agent has only ever seen the structured `kind`, never a
 * sentence in any language, and that stays true after this file exists.
 *
 * =========================== WHAT THIS IS NOT ==========================
 * Not a language-detection or speech-recognition system. Not a claim that
 * a real call happened in Hindi/English code-switched speech -- no real
 * outbound call happens anywhere in this project (see
 * `dashboard/src/Evidence.tsx`'s "why voice never appears" note: Razorpay's
 * API has no outbound voice calling to build a real integration against).
 * This is a deterministic template per signal kind, written once, the
 * same honest kind of thing the English "customer said" text already is.
 */

export interface HinglishTranscriptLine {
  readonly speaker: 'agent' | 'customer';
  readonly hinglish: string;
  readonly english: string;
}

const OPENING: HinglishTranscriptLine = {
  speaker: 'agent',
  hinglish: 'Namaste! Aapka payment complete nahi ho paya tha, main isi baare mein call kar rahi/raha hoon.',
  english: "Hello! Your payment didn't go through, I'm calling about that.",
};

const TRANSCRIPT_BY_SIGNAL: Readonly<Record<Exclude<CustomerSignal['kind'], 'no_answer'>, HinglishTranscriptLine>> = {
  promise_to_pay: {
    speaker: 'customer',
    hinglish: 'Haan haan, main jaldi hi pay kar dunga, thoda time dijiye.',
    english: "Yes yes, I'll pay soon, just give me some time.",
  },
  funds_available_now: {
    speaker: 'customer',
    hinglish: 'Ab account mein paisa aa gaya hai, aap abhi try kar sakte hain.',
    english: 'The funds are in my account now, you can try again.',
  },
  instrument_fixed: {
    speaker: 'customer',
    hinglish: 'Maine card/UPI theek kar diya hai, ab chalega.',
    english: "I've fixed the card/UPI, it'll work now.",
  },
  disputes_charge: {
    speaker: 'customer',
    hinglish: 'Yeh charge maine kiya hi nahi tha, isko cancel kijiye.',
    english: "I never made this charge, please cancel it.",
  },
  refused: {
    speaker: 'customer',
    hinglish: 'Mujhe interest nahi hai, please dobara call mat kijiye.',
    english: "I'm not interested, please don't call again.",
  },
};

const NO_ANSWER_LINE: HinglishTranscriptLine = {
  speaker: 'customer',
  hinglish: '(Call not answered / voicemail -- ring gaya par koi jawab nahi mila)',
  english: '(Call not answered / voicemail)',
};

/**
 * Full illustrative transcript for one voice step: the agent's opening
 * line plus the customer's response for the ACTUAL signal that was drawn
 * for this case (never a fabricated one). `no_answer` renders only the
 * unanswered-call marker, never a fabricated quote -- there was no
 * conversation, and pretending otherwise would be exactly the kind of
 * thing this file is built not to do.
 */
export function hinglishTranscriptFor(signal: CustomerSignal): readonly HinglishTranscriptLine[] {
  if (signal.kind === 'no_answer') return [OPENING, NO_ANSWER_LINE];
  return [OPENING, TRANSCRIPT_BY_SIGNAL[signal.kind]];
}

/** One-line Hinglish gloss of the detected intent, for a compact UI label. */
export const INTENT_LABEL_HINGLISH: Readonly<Record<CustomerSignal['kind'], string>> = {
  promise_to_pay: 'Vaada kiya hai (promise to pay)',
  funds_available_now: 'Paisa ab available hai (funds available now)',
  instrument_fixed: 'Instrument theek ho gaya (instrument fixed)',
  disputes_charge: 'Charge dispute kiya (disputes charge)',
  refused: 'Mana kar diya (refused)',
  no_answer: 'Call nahi utha (no answer)',
};
