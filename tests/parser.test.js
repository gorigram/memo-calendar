import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemo, parseTaskMemo } from '../worker/parser.js';

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

test('expands a shared time and title across every explicitly listed weekday', () => {
  const now = new Date('2026-10-21T02:00:00.000Z');
  const result = parseMemo('来週の火曜と水曜と土曜日に17時からバイト', now, 'Asia/Tokyo');
  assert.equal(result.ok, true);
  assert.equal(result.events.length, 3);
  assert.equal(result.event, undefined);
  assert.deepEqual(result.events.map(event => event.start), [
    '2026-10-27T08:00:00.000Z',
    '2026-10-28T08:00:00.000Z',
    '2026-10-31T08:00:00.000Z',
  ]);
  assert.deepEqual(result.events.map(event => event.title), ['バイト', 'バイト', 'バイト']);
  assert.ok(result.events.every(event => event.end === new Date(new Date(event.start).getTime() + 60 * 60 * 1000).toISOString()));
});

test('rejects an ambiguous multi-weekday phrase instead of creating a partial schedule', () => {
  const now = new Date('2026-10-21T02:00:00.000Z');
  const mixedWeeks = parseMemo('来週火曜と今週水曜17時 バイト', now, 'Asia/Tokyo');
  assert.equal(mixedWeeks.ok, false);
  assert.equal(mixedWeeks.reason, 'ambiguous-date');
  const missingTime = parseMemo('来週の火曜と水曜 バイト', now, 'Asia/Tokyo');
  assert.equal(missingTime.ok, false);
  assert.equal(missingTime.reason, 'missing-time');
  assert.equal(missingTime.events, undefined);
});

test('numbered schedule templates can supply a missing start time without weakening the time requirement', () => {
  const now = new Date('2026-10-21T02:00:00.000Z');
  const templates = [
    { id: 'work-evening', shortcut: '①', title: 'バイト', time: '17:00', durationMinutes: 60, recurrence: null },
    { id: 'work-night', shortcut: '②', title: 'バイト', time: '21:00', durationMinutes: 90, recurrence: null },
  ];
  const withoutTemplate = parseMemo('来週火曜', now, 'Asia/Tokyo');
  assert.equal(withoutTemplate.ok, false);
  assert.equal(withoutTemplate.reason, 'missing-time');
  const first = parseMemo('来週火曜①', now, 'Asia/Tokyo', templates);
  assert.equal(first.ok, true);
  assert.equal(first.event.title, 'バイト');
  assert.equal(first.event.start, '2026-10-27T08:00:00.000Z');
  assert.equal(new Date(first.event.end) - new Date(first.event.start), 60 * 60 * 1000);
  const second = parseMemo('来週火曜②', now, 'Asia/Tokyo', templates);
  assert.equal(second.event.start, '2026-10-27T12:00:00.000Z');
  assert.equal(new Date(second.event.end) - new Date(second.event.start), 90 * 60 * 1000);
  const explicitOverride = parseMemo('来週火曜② 19時 バイト', now, 'Asia/Tokyo', templates);
  assert.equal(explicitOverride.event.start, '2026-10-27T10:00:00.000Z');
  assert.equal(new Date(explicitOverride.event.end) - new Date(explicitOverride.event.start), 90 * 60 * 1000);
  assert.equal(parseMemo('来週火曜①②', now, 'Asia/Tokyo', templates).reason, 'ambiguous-template');
  assert.equal(parseMemo('来週火曜⑳ 17時', now, 'Asia/Tokyo', templates).reason, 'unknown-template');
  const batch = parseMemo('来週の火曜と水曜と土曜日に①', now, 'Asia/Tokyo', templates);
  assert.equal(batch.ok, true);
  assert.equal(batch.events.length, 3);
  assert.ok(batch.events.every(event => event.title === 'バイト' && event.start.endsWith('T08:00:00.000Z')));
  const remainingSlot = templates.filter(template => template.shortcut !== '①');
  assert.equal(parseMemo('来週火曜①', now, 'Asia/Tokyo', remainingSlot).reason, 'unknown-template');
  const editedSlot = remainingSlot.map(template => ({ ...template, time: '22:00', title: '夜勤', durationMinutes: 120 }));
  const edited = parseMemo('来週火曜②', now, 'Asia/Tokyo', editedSlot);
  assert.equal(edited.event.title, '夜勤');
  assert.equal(edited.event.start, '2026-10-27T13:00:00.000Z');
  assert.equal(new Date(edited.event.end) - new Date(edited.event.start), 2 * 60 * 60 * 1000);
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

test('expands independent date-time pairs into an atomic list with one shared title', () => {
  const now = new Date('2026-10-21T03:00:00.000Z');
  for (const memo of [
    '10/29 10:00と11/5 14:00 ワンキャリア',
    '2026年10月29日10時と11月5日14時 ワンキャリア',
    '１０／２９ １０：００と１１／５ １４：００ ワンキャリア',
  ]) {
    const result = parseMemo(memo, now, 'Asia/Tokyo');
    assert.equal(result.ok, true, memo);
    assert.equal(result.events.length, 2, memo);
    assert.deepEqual(result.events.map(event => event.title), ['ワンキャリア', 'ワンキャリア']);
    assert.deepEqual(result.events.map(event => event.start), [
      '2026-10-29T01:00:00.000Z',
      '2026-11-05T05:00:00.000Z',
    ]);
    assert.ok(result.events.every(event => new Date(event.end) - new Date(event.start) === 60 * 60 * 1000));
  }

  const yearBoundary = parseMemo('12/29 10:00と1/5 14:00 ワンキャリア', now, 'Asia/Tokyo');
  assert.equal(yearBoundary.ok, true);
  assert.deepEqual(yearBoundary.events.map(event => event.start), [
    '2026-12-29T01:00:00.000Z',
    '2027-01-05T05:00:00.000Z',
  ]);
  const reverseOrder = parseMemo('11/5 14:00と10/29 10:00 ワンキャリア', now, 'Asia/Tokyo');
  assert.equal(reverseOrder.ok, true);
  assert.deepEqual(reverseOrder.events.map(event => event.start), [
    '2026-11-05T05:00:00.000Z',
    '2026-10-29T01:00:00.000Z',
  ]);
});

test('rejects incomplete or ambiguous date-time pairs without returning partial events', () => {
  const now = new Date('2026-10-21T03:00:00.000Z');
  for (const memo of [
    '10/29 10:00と11/5 ワンキャリア',
    '10/29 10:00と11/5 14:00と15:00 ワンキャリア',
    '10/29 10:00と2/30 14:00 ワンキャリア',
    '10/29 10:00と11/5 14:00と ワンキャリア',
    '確認 10/29 10:00と11/5 14:00 ワンキャリア',
  ]) {
    const result = parseMemo(memo, now, 'Asia/Tokyo');
    assert.equal(result.ok, false, memo);
    assert.equal(result.events, undefined, memo);
  }
});

test('task parser requires an explicit real date and accepts optional due time', () => {
  const missing = parseTaskMemo('14時 資料を提出', reference, 'Asia/Tokyo');
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing-date');
  const untimed = parseTaskMemo('明日 資料を提出', reference, 'Asia/Tokyo');
  assert.equal(untimed.ok, true);
  assert.equal(untimed.event.type, 'task');
  assert.equal(untimed.event.dueDate, '2026-10-19');
  assert.equal(untimed.event.dueTime, null);
  assert.equal(untimed.event.title, '資料を提出');
  const timed = parseTaskMemo('10/20(火) 午後3時までに申込書を送る', reference, 'Asia/Tokyo');
  assert.equal(timed.ok, true);
  assert.equal(timed.event.dueDate, '2026-10-20');
  assert.equal(timed.event.dueTime, '15:00');
  assert.equal(timed.event.title, '申込書を送る');
});

test('task parser preserves task and TODO wording in titles', () => {
  const taskTitle = parseTaskMemo('明日 QAタスク検証', reference, 'Asia/Tokyo');
  assert.equal(taskTitle.ok, true);
  assert.equal(taskTitle.event.title, 'QAタスク検証');
  const todoTitle = parseTaskMemo('明後日 TODO: タスクフォース資料', reference, 'Asia/Tokyo');
  assert.equal(todoTitle.ok, true);
  assert.equal(todoTitle.event.title, 'TODO: タスクフォース資料');
});

test('task parser rejects impossible and underspecified dates and embeds cleanly', () => {
  assert.equal(parseTaskMemo('2月30日 書類', reference, 'Asia/Tokyo').reason, 'invalid-date');
  assert.equal(parseTaskMemo('来週 書類', reference, 'Asia/Tokyo').reason, 'ambiguous-date');
  assert.equal(parseTaskMemo('毎週火曜 書類', reference, 'Asia/Tokyo').reason, 'ambiguous-date');
  const embedded = new Function('return (' + parseTaskMemo.toString() + ')')();
  assert.equal(embedded('今日 17時 支払い', reference, 'Asia/Tokyo').event.dueDate, '2026-10-18');
});
