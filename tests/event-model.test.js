import test from 'node:test';
import assert from 'node:assert/strict';
import { FREQ_TO_UI, UI_TO_FREQ, normalizeRecurrence, serializeEvent, toBackendRecurrence } from '../worker/event-model.js';

test('normalizes Worker RRULE arrays from API and local reload to UI recurrence names', () => {
  for (const [rrule, expected] of [
    ['RRULE:FREQ=WEEKLY;BYDAY=TU', 'weekly'],
    ['RRULE:FREQ=DAILY', 'daily'],
    ['RRULE:FREQ=MONTHLY;BYMONTHDAY=20', 'monthly'],
  ]) {
    assert.equal(normalizeRecurrence([rrule]), expected);
    assert.equal(normalizeRecurrence(expected), expected);
  }
  assert.equal(normalizeRecurrence([]), null);
  assert.equal(normalizeRecurrence(null), null);
});

test('serializes recurrence to the API format and preserves existing RRULE modifiers when unchanged', () => {
  assert.deepEqual(toBackendRecurrence('weekly'), ['RRULE:FREQ=WEEKLY']);
  assert.deepEqual(toBackendRecurrence('daily'), ['RRULE:FREQ=DAILY']);
  assert.deepEqual(toBackendRecurrence('monthly'), ['RRULE:FREQ=MONTHLY']);
  assert.deepEqual(toBackendRecurrence(null), []);
  const existing = ['RRULE:FREQ=WEEKLY;BYDAY=TU'];
  assert.deepEqual(serializeEvent({ recurrence: 'weekly', recurrenceRule: existing }).recurrence, existing);
  assert.deepEqual(serializeEvent({ recurrence: 'daily', recurrenceRule: existing }).recurrence, ['RRULE:FREQ=DAILY']);
});

test('browser-embedded helpers preserve recurrence across API load, local reload, and save', () => {
  const browserModel = new Function(`return (()=>{
    const FREQ_TO_UI=${JSON.stringify(FREQ_TO_UI)};
    const UI_TO_FREQ=${JSON.stringify(UI_TO_FREQ)};
    const normalizeRecurrence=(${normalizeRecurrence.toString()});
    const toBackendRecurrence=(${toBackendRecurrence.toString()});
    const serializeEvent=(${serializeEvent.toString()});
    return {normalizeRecurrence,serializeEvent};
  })()` )();
  const fromApi = { id: 'series-7', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] };
  const clientEvent = { ...fromApi, recurrenceRule: fromApi.recurrence, recurrence: browserModel.normalizeRecurrence(fromApi.recurrence) };
  const persistedAgain = JSON.parse(JSON.stringify(clientEvent));
  assert.equal(persistedAgain.recurrence, 'weekly');
  assert.deepEqual(browserModel.serializeEvent(persistedAgain).recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=TU']);
});
