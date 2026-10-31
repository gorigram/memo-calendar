import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
const lineContaining = (needle) => source.split(/\r?\n/).find(line => line.includes(needle));

test('capture only submits from the explicit add button', () => {
  assert.doesNotMatch(source, /autoAdd|scheduleAutoAdd|cancelAutoAdd|autoCountdown|countdownValue/);
  assert.match(source, /\$\('#addButton'\)\.addEventListener\('click',createEvent\)/);
  assert.doesNotMatch(source, /memoInput'\)\.addEventListener\('keydown'.*createEvent/);
  assert.match(lineContaining('async function createEvent'), /state\.composing\|\|state\.creating/);
  assert.match(lineContaining('function queueParse'), /\$\('#addButton'\)\.disabled=true/);
  assert.match(lineContaining('function parsePreview'), /if\(state\.composing\)return/);
});

test('pending batch recovery only reads at startup and offers exact-payload manual retry', async () => {
  const recoverySource = lineContaining('async function recoverPendingBatch').trim();
  assert.match(recoverySource, /api\('\/api\/events'\)/);
  assert.doesNotMatch(recoverySource, /method:'POST'/);
  assert.match(source, /recoveryBatch\?\.batchId===submittedBatchId\?Boolean\(state\.recoveryBatch\.autoSync\)/);
  assert.match(lineContaining('async function createEvent'), /events:previewEvents\.map\(event=>serializeEvent\(event\)\)/);

  const pending = {
    batchId: 'batch_1', accountKey: 'acct', autoSync: false,
    originalMemo: '明日1100会議',
    events: [{ id: 'event_1', title: '会議', start: '2026-11-02T02:00:00.000Z', end: '2026-11-02T03:00:00.000Z' }],
  };
  const state = { status: { mode: 'cloud', authenticated: true, accountKey: 'acct' } };
  const calls = [];
  const elements = { '#pendingRecovery': { hidden: true }, '#restorePending': {}, '#memoInput': { value: '', focus() {} } };
  let memoInputs = 0;
  const context = {
    state,
    pendingBatchList: () => [pending],
    api: async (path, options) => { calls.push({ path, options }); return { ok: true, data: { events: [] } }; },
    normalizeEvent: event => ({ ...event, cloudStored: true }),
    $: selector => elements[selector],
    onMemoInput: () => { memoInputs++; },
    toast: () => {},
  };
  const recoverPendingBatch = vm.runInNewContext(`(${recoverySource})`, context);
  await recoverPendingBatch();
  assert.deepEqual(calls.map(call => [call.path, call.options]), [['/api/events', undefined]]);
  assert.equal(elements['#pendingRecovery'].hidden, false);
  elements['#restorePending'].onclick();
  assert.equal(state.pendingBatchId, pending.batchId);
  assert.equal(state.pendingBatchMemo, pending.originalMemo);
  assert.equal(state.recoveryBatch, pending);
  assert.equal(elements['#memoInput'].value, pending.originalMemo);
  assert.equal(memoInputs, 1);
  assert.equal(calls.length, 1, 'the restore action itself does not submit');
});


test('cloud success forgets the submitted batch ID and preserves memo edits made in flight', async () => {
  const createSource = lineContaining('async function createEvent').trim();
  const createEvent = vm.runInNewContext(`(${createSource})`);
  const pendingBatches = [];
  const forgotten = [];
  const stored = new Map();
  const memoInput = { value: '明日1100会議', focus() {} };
  const button = { disabled: false, innerHTML: '' };
  const preview = { classList: { remove() {} }, querySelector: () => null };
  const previewLabel = { textContent: '' };
  const elements = { '#memoInput': memoInput, '#addButton': button, '#preview': preview, '#parseModeLabel': previewLabel };
  const event = { id: 'event-1', title: '会議', type: 'schedule', start: '2026-11-02T02:00:00.000Z', end: '2026-11-02T03:00:00.000Z' };
  const state = {
    composing: false, creating: false, previewText: memoInput.value, captureMode: 'schedule', preview: null,
    previewEvents: [event], pendingBatchId: 'batch-old', pendingBatchMemo: null, recoveryBatch: null,
    parseGeneration: 0, parseTimer: 0, apiTimer: 0, events: [], remote: false, cloudUnavailable: false,
    prefs: { autoSync: false }, status: { mode: 'cloud', authenticated: true, accountKey: 'acct', google: { connected: false } },
  };
  let finishRequest;
  const context = {
    LOCAL_KEY: 'michi.events.v1', state, document: { querySelector: selector => elements[selector] },
    $: selector => elements[selector], clearTimeout() {}, queueParse() {},
    cloudStorageActive: () => true, serializeEvent: value => ({ ...value }), normalizeEvent: value => ({ ...value }),
    id: () => 'unused', storePendingBatch: value => pendingBatches.push(value),
    forgetPendingBatch: value => forgotten.push(value),
    localStorage: { setItem: (key, value) => stored.set(key, value) },
    api: (_path, _options) => new Promise(resolve => { finishRequest = resolve; }),
    render() {}, renderTemplates() {}, toast() {},
  };
  const submit = vm.runInNewContext(`(${createSource})`, context);
  const operation = submit();
  await Promise.resolve();
  assert.equal(pendingBatches[0].batchId, 'batch-old');
  memoInput.value = '明後日1400面談';
  state.pendingBatchId = 'batch-new'; // input parsing completed while the request was pending
  finishRequest({ ok: true, data: { events: [event], syncResults: [] } });
  await operation;
  assert.deepEqual(forgotten, ['batch-old']);
  assert.equal(memoInput.value, '明後日1400面談');
  assert.equal(state.pendingBatchId, 'batch-new');
  assert.equal(state.creating, false);
  assert.equal(JSON.parse(stored.get('michi.events.v1')).length, 1);
});


test('template names insert at the caret without introducing newlines', () => {
  const insertSource = lineContaining('function insertTemplateName').trim();
  const insertTemplateName = vm.runInNewContext(`(${insertSource.replace(/^function /, 'function ')})`);
  const makeInput = (value, caret, end = caret) => ({
    value, selectionStart: caret, selectionEnd: end, focused: false,
    setSelectionRange(start, finish) { this.selectionStart = start; this.selectionEnd = finish; },
    focus() { this.focused = true; },
  });
  const name = 'バイト早番';
  const empty = makeInput('', 0);
  insertTemplateName(empty, name);
  assert.equal(empty.value, name);
  assert.equal(empty.selectionStart, name.length);

  const datePrefix = makeInput('来週火', '来週火'.length);
  insertTemplateName(datePrefix, name);
  assert.equal(datePrefix.value, '来週火 バイト早番');

  const twoLines = makeInput('来週火 バイト早番\n来週水', '来週火 バイト早番\n来週水'.length);
  insertTemplateName(twoLines, name);
  assert.equal(twoLines.value, '来週火 バイト早番\n来週水 バイト早番');
  assert.equal((twoLines.value.match(/\n/g) || []).length, 1);

  const midLine = makeInput('来週火 会議', '来週火'.length);
  insertTemplateName(midLine, name);
  assert.equal(midLine.value, '来週火 バイト早番 会議');
  assert.equal(midLine.focused, true);
});
