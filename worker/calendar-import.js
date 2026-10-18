/** Parse Google all-day date-only values as local calendar dates (not UTC instants). */
export function localEventInstant(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day).toISOString();
  }
  return new Date(value).toISOString();
}

/** Merge ephemeral Google imports and live app-event overrides into the display set. */
export function mergeCalendarEvents(appEvents, googleEvents, appEventOverrides) {
  const instant = value => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split('-').map(Number);
      return new Date(year, month - 1, day).toISOString();
    }
    return value;
  };
  const overrides = new Map((appEventOverrides || []).map(event => [event.id, event]));
  const ownedGoogleIds = new Set((appEvents || []).map(event => event.googleEventId).filter(Boolean));
  const app = (appEvents || []).flatMap(event => {
    const override = overrides.get(event.id);
    if (override && override.deleted) return [];
    return [override
      ? { ...event, ...override, start: instant(override.start) || event.start, end: instant(override.end) || event.end, id: event.id, recurrence: event.recurrence, recurrenceRule: event.recurrenceRule, cloudStored: event.cloudStored, googleEventId: event.googleEventId }
      : event];
  });
  const imported = (googleEvents || []).filter(event => event.status !== 'cancelled' && !event.deleted
    && !ownedGoogleIds.has(event.googleEventId)
    && !(event.recurringEventId && ownedGoogleIds.has(event.recurringEventId)));
  const seen = new Set();
  return [...app, ...imported].filter(event => {
    const key = event.googleEventId || `${event.id}@${event.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Expand a date-only Google range to every visible day; Google end dates are exclusive. */
export function allDayOccurrences(event, from, to) {
  const out = [];
  const end = new Date(event.end);
  const first = new Date(event.start);
  const cursor = first < from ? new Date(from) : first;
  for (; cursor < end && cursor < to; cursor.setDate(cursor.getDate() + 1)) {
    const start = new Date(cursor);
    const next = new Date(start);
    next.setDate(next.getDate() + 1);
    out.push({ event, start, end: next, number: 1 });
  }
  return out;
}
