export const FREQ_TO_UI = Object.freeze({ DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' });
export const UI_TO_FREQ = Object.freeze({ daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' });

/** Convert the UI's short recurrence names and Google RRULE arrays into one UI value. */
export function normalizeRecurrence(value) {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const direct = entry.trim().toLowerCase();
    if (UI_TO_FREQ[direct]) return direct;
    const match = direct.match(/(?:^|[;:])(?:rrule:)?freq=(daily|weekly|monthly)(?:;|$)/i);
    if (match) return FREQ_TO_UI[match[1].toUpperCase()];
  }
  return null;
}

/** Convert UI recurrence values into the RRULE array accepted by the Worker API. */
export function toBackendRecurrence(value) {
  const normalized = normalizeRecurrence(value);
  return normalized ? [`RRULE:FREQ=${UI_TO_FREQ[normalized]}`] : [];
}

/** Build the network payload without leaking UI-only recurrence values. */
export function serializeEvent(event) {
  const normalized = normalizeRecurrence(event.recurrence);
  const original = Array.isArray(event.recurrenceRule) ? event.recurrenceRule.filter(rule => typeof rule === 'string' && /^RRULE:FREQ=(DAILY|WEEKLY|MONTHLY)(;.*)?$/i.test(rule)) : [];
  const originalType = normalizeRecurrence(original);
  const recurrence = normalized && normalized === originalType && original.length
    ? original
    : toBackendRecurrence(normalized);
  return { ...event, recurrence };
}
