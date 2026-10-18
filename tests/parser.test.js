import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemo } from '../worker/parser.js';

const reference = new Date(2026, 9, 18, 9, 0, 0);

test('parses relative Japanese dates, meridiem, and an explicit duration', () => {
  const result = parseMemo('明日 午後3時 セミナー 1時間半', reference);
  assert.equal(result.ok, true);
  assert.equal(result.event.title, 'セミナー');
  assert.equal(result.durationSpecified, true);
  const start = new Date(result.event.start);
  const end = new Date(result.event.end);
  assert.equal(start.getDate(), 19);
  assert.equal(start.getHours(), 15);
  assert.equal(end - start, 90 * 60 * 1000);
});

test('requires a start time and does not invent one', () => {
  const result = parseMemo('明日 歯医者', reference);
  assert.equal(result.ok, false);
  assert.equal(result.needsClarification, true);
  assert.equal(result.reason, 'missing-time');
});

test('marks the one-hour fallback only when no duration or end time was provided', () => {
  const fallback = parseMemo('今日 14時 歯医者', reference);
  const explicitMinutes = parseMemo('今日 14時 QA 90分', reference);
  const explicitRange = parseMemo('今日 14時から15時 QA', reference);
  assert.equal(fallback.durationSpecified, false);
  assert.equal(explicitMinutes.durationSpecified, true);
  assert.equal(explicitRange.durationSpecified, true);
});

test('asks for a weekday when a relative week is underspecified', () => {
  const result = parseMemo('来週 セミナー 10時', reference);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous-date');
});

test('rejects impossible dates instead of normalizing them', () => {
  const result = parseMemo('2月30日 10時 病院', reference);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-date');
});

test('recognizes weekly series and half-hour times', () => {
  const result = parseMemo('毎週火曜 9時半 アルバイト', reference);
  assert.equal(result.ok, true);
  assert.equal(result.event.title, 'アルバイト');
  assert.equal(result.event.recurrence, 'weekly');
  assert.equal(new Date(result.event.start).getHours(), 9);
  assert.equal(new Date(result.event.start).getMinutes(), 30);
});

test('does not mistake year digits for an explicit time', () => {
  const result = parseMemo('2026年10月19日 病院', reference);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-time');
});

test('keeps minutes in a start time out of the inferred duration', () => {
  const result = parseMemo('明日 14時30分 会議', reference);
  assert.equal(result.ok, true);
  assert.equal(result.event.title, '会議');
  assert.equal(new Date(result.event.start).getHours(), 14);
  assert.equal(new Date(result.event.start).getMinutes(), 30);
  assert.equal(new Date(result.event.end) - new Date(result.event.start), 60 * 60 * 1000);
});

test('parses ISO dates without treating their hyphens as an end-time range', () => {
  const result = parseMemo('2026-10-20 14:00 第3回 セミナー', reference);
  assert.equal(result.ok, true);
  assert.equal(result.event.title, '第3回 セミナー');
  const start = new Date(result.event.start);
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 9);
  assert.equal(start.getDate(), 20);
  assert.equal(start.getHours(), 14);
});

test('parses Japanese absolute dates without consuming the month or day as a time', () => {
  const result = parseMemo('2026年10月20日 14時 プロジェクト相談', reference);
  assert.equal(result.ok, true);
  assert.equal(result.event.title, 'プロジェクト相談');
  const start = new Date(result.event.start);
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 9);
  assert.equal(start.getDate(), 20);
  assert.equal(start.getHours(), 14);
});

test('uses Monday as the week boundary for next-week weekdays', () => {
  const result = parseMemo('来週火曜 10時 セミナー', reference);
  assert.equal(result.ok, true);
  assert.equal(new Date(result.event.start).getDate(), 20);
});

test('accepts a valid overnight range and rejects an implausible reversed range', () => {
  const overnight = parseMemo('今日 23時から午前1時 仕事', reference);
  assert.equal(overnight.ok, true);
  assert.equal(new Date(overnight.event.end) - new Date(overnight.event.start), 2 * 60 * 60 * 1000);
  const reversed = parseMemo('今日 14時から13時 会議', reference);
  assert.equal(reversed.ok, false);
  assert.equal(reversed.reason, 'invalid-range');
});

test('preserves numbers in titles without a time suffix', () => {
  const result = parseMemo('今日 10時 第3回講義', reference);
  assert.equal(result.ok, true);
  assert.equal(result.event.title, '第3回講義');
});

test('returns the matching instant for an explicit IANA timezone', () => {
  const result = parseMemo('2026年10月20日 14時 相談', new Date('2026-10-20T00:00:00Z'), 'America/Los_Angeles');
  assert.equal(result.ok, true);
  assert.equal(result.event.start, '2026-10-20T21:00:00.000Z');
  assert.equal(result.event.timezone, 'America/Los_Angeles');
});

test('can be embedded in the browser without module-scope helper dependencies', () => {
  const embedded = new Function('return (' + parseMemo.toString() + ')')();
  const result = embedded('明日 14時30分 歯医者', new Date('2026-10-18T00:00:00Z'), 'Asia/Tokyo');
  assert.equal(result.ok, true);
  assert.equal(result.event.start, '2026-10-19T05:30:00.000Z');
});

test('normalizes full-width memo text and parses dates followed by a weekday note', () => {
  const fullWidth = parseMemo('明日１４時３０分 バイト ２時間', reference);
  assert.equal(fullWidth.ok, true);
  assert.equal(fullWidth.event.title, 'バイト');
  assert.equal(new Date(fullWidth.event.start).getHours(), 14);
  assert.equal(new Date(fullWidth.event.start).getMinutes(), 30);
  assert.equal(new Date(fullWidth.event.end) - new Date(fullWidth.event.start), 2 * 60 * 60 * 1000);
  const slashDate = parseMemo('10/20(火) 14時 ゼミ', reference);
  assert.equal(slashDate.ok, true);
  assert.equal(slashDate.event.title, 'ゼミ');
  assert.equal(new Date(slashDate.event.start).getDate(), 20);
});
