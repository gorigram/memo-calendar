import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allDayOccurrences, localEventInstant, mergeCalendarEvents } from '../worker/calendar-import.js';

test('all-day Google dates stay on their local calendar day', () => {
  const parsed = new Date(localEventInstant('2026-10-20'));
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 9);
  assert.equal(parsed.getDate(), 20);
});

test('multi-day all-day events are clipped into the visible week using an exclusive end', () => {
  const event = { id: 'holiday', allDay: true, start: localEventInstant('2026-10-18'), end: localEventInstant('2026-10-22') };
  const days = allDayOccurrences(event, new Date(2026, 9, 19), new Date(2026, 9, 26));
  assert.deepEqual(days.map(item => item.start.getDate()), [19, 20, 21]);
  assert.equal(days[2].end.getDate(), 22);
});

test('Google app overrides update linked one-offs and hide deleted ones', () => {
  const app = [
    { id: 'one', title: 'old', start: '2026-10-20T09:00:00+09:00', end: '2026-10-20T10:00:00+09:00', cloudStored: true, googleEventId: 'g-one' },
    { id: 'two', title: 'cancelled', start: '2026-10-21T09:00:00+09:00', end: '2026-10-21T10:00:00+09:00', cloudStored: true, googleEventId: 'g-two' },
  ];
  const merged = mergeCalendarEvents(app, [], [
    { id: 'one', title: 'moved', start: '2026-10-22T11:00:00+09:00', end: '2026-10-22T12:00:00+09:00', source: 'google', liveOverride: true },
    { id: 'two', deleted: true, source: 'google', liveOverride: true },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'one');
  assert.equal(merged[0].title, 'moved');
  assert.equal(merged[0].googleEventId, 'g-one');
  assert.equal(merged[0].cloudStored, true);
});

test('Google all-day overrides normalize date-only start and exclusive end before display', () => {
  const [event] = mergeCalendarEvents(
    [{ id: 'one', title: 'meeting', start: '2026-10-20T09:00:00+09:00', end: '2026-10-20T10:00:00+09:00', cloudStored: true, googleEventId: 'g-one' }],
    [],
    [{ id: 'one', title: 'holiday', start: '2026-10-21', end: '2026-10-23', allDay: true }],
  );
  assert.equal(new Date(event.start).getDate(), 21);
  assert.equal(new Date(event.end).getDate(), 23);
  assert.equal(event.allDay, true);
});

test('Google imports dedupe duplicates but retain separate recurrence instances and exclude app-owned series', () => {
  const app = [{ id: 'app', title: 'series', googleEventId: 'master-1' }];
  const external = [
    { id: 'gcal-x', googleEventId: 'x', title: 'external', start: '2026-10-20T09:00:00Z' },
    { id: 'gcal-x-duplicate', googleEventId: 'x', title: 'external duplicate', start: '2026-10-20T09:00:00Z' },
    { id: 'gcal-y1', googleEventId: 'y1', recurringEventId: 'series-y', start: '2026-10-20T10:00:00Z' },
    { id: 'gcal-y2', googleEventId: 'y2', recurringEventId: 'series-y', start: '2026-10-21T10:00:00Z' },
    { id: 'gcal-owned', googleEventId: 'owned-instance', recurringEventId: 'master-1', start: '2026-10-21T12:00:00Z' },
    { id: 'gcal-cancelled', googleEventId: 'cancelled', status: 'cancelled' },
  ];
  const merged = mergeCalendarEvents(app, external, []);
  assert.deepEqual(merged.map(event => event.id), ['app', 'gcal-x', 'gcal-y1', 'gcal-y2']);
});
