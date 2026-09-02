import { DAY, HOUR, MINUTE, type Channel, type CustomerProfile, type Timestamp } from '../domain/types.js';
import type { HistoryEntry } from '../policies/types.js';

/**
 * Compliance rules for contacting customers.
 *
 * These are hard constraints, not policy preferences. A recovery agent that can
 * talk its way past them is not a compliant system, so they live outside the
 * policy entirely and are evaluated on every proposed contact.
 *
 * The distinction that matters throughout: some rules are TIMING rules (you may
 * not do this *now*, but you may later) and some are PERMISSION rules (you may
 * never do this). Timing rules produce a deferral; permission rules produce a
 * block. Conflating the two either loses recoverable revenue or breaks the law.
 */

/** No outbound contact before 09:00 or from 21:00, in the customer's local time. */
export const QUIET_HOURS = { startHour: 21, endHour: 9 } as const;

/**
 * Channels covered by the TRAI do-not-disturb registry.
 *
 * DND is a telecom regulation: it governs commercial calls and SMS. Email and
 * WhatsApp fall outside it and are governed by per-channel consent instead.
 * Treating DND as a blanket ban on all contact would be simpler, but it is not
 * what the rule says, and it would surrender recoverable revenue on channels
 * the customer has actually opted in to.
 */
export const DND_RESTRICTED_CHANNELS: readonly Channel[] = ['sms', 'voice'];

export interface ComplianceConfig {
  /** Maximum outbound contacts to one customer in a rolling 24 hours. */
  readonly maxContactsPerDay: number;
  /** Maximum outbound contacts to one customer in a rolling 7 days. */
  readonly maxContactsPerWeek: number;
  /** Minimum gap between two contacts on any channel. */
  readonly minGapBetweenContactsMs: number;
}

export const DEFAULT_COMPLIANCE: ComplianceConfig = {
  maxContactsPerDay: 2,
  maxContactsPerWeek: 5,
  minGapBetweenContactsMs: 4 * HOUR,
};

export type ComplianceVerdict =
  | { readonly kind: 'allow' }
  /** Not permitted now, but permitted from `notBefore`. The agent should wait. */
  | {
      readonly kind: 'defer';
      readonly notBefore: Timestamp;
      readonly rule: string;
      readonly explanation: string;
    }
  /** Never permitted for this customer and channel. The agent must do something else. */
  | { readonly kind: 'block'; readonly rule: string; readonly explanation: string };

/** Wall-clock hour and minute in the customer's local timezone. */
function localTime(at: Timestamp, utcOffsetMinutes: number): { hour: number; minute: number } {
  const shifted = new Date(at + utcOffsetMinutes * MINUTE);
  return { hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
}

function isQuietHour(hour: number): boolean {
  // The window wraps midnight, so this is a union, not a range.
  return hour >= QUIET_HOURS.startHour || hour < QUIET_HOURS.endHour;
}

/**
 * The next instant at or after `at` that falls outside quiet hours.
 *
 * This is the piece that turns a compliance block into intelligent behaviour:
 * a message that would land at 21:30 is not dropped, it is queued for 09:00.
 */
export function nextPermittedContactTime(
  at: Timestamp,
  utcOffsetMinutes: number,
): Timestamp {
  const { hour } = localTime(at, utcOffsetMinutes);
  if (!isQuietHour(hour)) return at;

  const localMs = at + utcOffsetMinutes * MINUTE;
  const localDayStart = Math.floor(localMs / DAY) * DAY;
  let target = localDayStart + QUIET_HOURS.endHour * HOUR;

  // If 09:00 today has already passed (i.e. we are in the 21:00-23:59 block),
  // the next window opens at 09:00 tomorrow.
  if (target <= localMs) target += DAY;

  return target - utcOffsetMinutes * MINUTE;
}

function contactsInWindow(
  history: readonly HistoryEntry[],
  now: Timestamp,
  windowMs: number,
): HistoryEntry[] {
  return history.filter(
    (h) =>
      h.action.kind === 'contact_customer' &&
      h.blockedBy === undefined &&
      now - h.at < windowMs,
  );
}

/**
 * Evaluate a proposed contact.
 *
 * @param channel   the channel the policy wants to use
 * @param customer  who we would be contacting
 * @param at        when the contact would fire
 * @param history   everything already done on this case
 */
export function evaluateCompliance(
  channel: Channel,
  customer: CustomerProfile,
  at: Timestamp,
  history: readonly HistoryEntry[],
  config: ComplianceConfig = DEFAULT_COMPLIANCE,
): ComplianceVerdict {
  // --- Permission rules: never allowed, no amount of waiting helps. ---

  if (customer.dndRegistered && DND_RESTRICTED_CHANNELS.includes(channel)) {
    return {
      kind: 'block',
      rule: 'DND_REGISTERED',
      explanation: `Customer is on the TRAI do-not-disturb registry, which covers ${DND_RESTRICTED_CHANNELS.join(' and ')}. Consent-based channels and silent retries remain available.`,
    };
  }

  if (!customer.consent[channel]) {
    return {
      kind: 'block',
      rule: 'NO_CONSENT',
      explanation: `Customer has not opted in to ${channel}. Contacting them on it would be a consent violation.`,
    };
  }

  // --- Timing rules: not now, but later. ---

  const permittedFrom = nextPermittedContactTime(at, customer.utcOffsetMinutes);
  if (permittedFrom > at) {
    const { hour, minute } = localTime(at, customer.utcOffsetMinutes);
    const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return {
      kind: 'defer',
      notBefore: permittedFrom,
      rule: 'QUIET_HOURS',
      explanation: `Contact would land at ${clock} local, inside quiet hours (${QUIET_HOURS.startHour}:00-0${QUIET_HOURS.endHour}:00). Deferred to the next permitted window rather than dropped.`,
    };
  }

  const recent = contactsInWindow(history, at, config.minGapBetweenContactsMs);
  const lastContact = recent.at(-1);
  if (lastContact) {
    const notBefore = lastContact.at + config.minGapBetweenContactsMs;
    return {
      kind: 'defer',
      notBefore: nextPermittedContactTime(notBefore, customer.utcOffsetMinutes),
      rule: 'CONTACT_COOLDOWN',
      explanation: `Last contact was ${((at - lastContact.at) / HOUR).toFixed(1)}h ago; minimum gap is ${config.minGapBetweenContactsMs / HOUR}h.`,
    };
  }

  const today = contactsInWindow(history, at, DAY);
  if (today.length >= config.maxContactsPerDay) {
    const oldest = today[0]!;
    return {
      kind: 'defer',
      notBefore: nextPermittedContactTime(oldest.at + DAY, customer.utcOffsetMinutes),
      rule: 'DAILY_CONTACT_CAP',
      explanation: `Already contacted ${today.length} times in the last 24h (cap ${config.maxContactsPerDay}).`,
    };
  }

  const week = contactsInWindow(history, at, 7 * DAY);
  if (week.length >= config.maxContactsPerWeek) {
    return {
      kind: 'block',
      rule: 'WEEKLY_CONTACT_CAP',
      explanation: `Already contacted ${week.length} times this week (cap ${config.maxContactsPerWeek}). No further outreach on this case.`,
    };
  }

  return { kind: 'allow' };
}

/**
 * Customer-annoyance weighting.
 *
 * Rupee cost alone cannot justify restraint: recovered amounts dwarf per-message
 * costs by orders of magnitude. What actually constrains a recovery system is
 * how much it irritates the merchant's customers, and that is not denominated in
 * rupees. So we score it separately.
 */
export const SPAM_POINTS: Readonly<Record<Channel, number>> = {
  email: 1,
  sms: 5,
  whatsapp: 5,
  voice: 10,
};

/** A silent retry is invisible to the customer and costs nothing in goodwill. */
export const RETRY_SPAM_POINTS = 0;
