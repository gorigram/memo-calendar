import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { handleApi } from "../worker/backend.js";

globalThis.crypto ||= webcrypto;
const secret = "test-session-secret-that-is-long-enough";
async function cookie(sub = "google-user-1") {
  const payload = btoa(JSON.stringify({ sub, exp: Date.now() + 60_000 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `memo_session=${payload}.${signature}`;
}
function fakeDb() {
  const rows = new Map(), states = new Map(), templates = new Map(), batches = new Map(), persistedEvents = new Map(), calls = [];
  const key = (owner, id) => `${owner}\0${id}`;
  const db = { prepare(sql) { let args = []; return { sql, get args() { return args; }, bind(...values) { args = values; return this; }, async first() { if (sql.includes("google_tokens")) return rows.get(args[0]) || null; if (sql.includes("oauth_states")) return states.get(args[0]) || null; if (sql.includes("FROM event_batches")) return batches.get(key(args[0], args[1])) || null; return null; }, async all() { if (sql.includes("FROM event_templates")) return { results: [...templates.values()].filter(row => row.user_id === args[0]) }; if (sql.includes("SELECT id,title,start,end,timezone,recurrence,type,due_date")) { const found = [...persistedEvents.values()].filter(row => row.user_id === args[0]); return { results: found.length ? found : db.allRows }; } if (sql.includes("SELECT id,title,start,end,timezone,recurrence,google_event_id FROM events")) return { results: db.appRows }; return { results: db.allRows }; }, async run() { calls.push({ sql, args }); if (sql.includes("INSERT INTO oauth_states")) states.set(args[0], { code_verifier: args[1], expires_at: args[2], owner_id: args[3] }); if (sql.includes("DELETE FROM oauth_states")) states.delete(args[0]); if (sql.includes("UPDATE event_batches") && !db.failBatchReceipt) { const row = batches.get(key(args[3], args[4])); if (row && row.claim_nonce === args[5]) { row.status = args[0]; row.sync_json = args[1]; } } return { meta: { changes: 1 } }; } }; }, async batch(statements) {
    const nextTemplates = new Map(templates), nextBatches = new Map([...batches].map(([k, v]) => [k, structuredClone(v)])), nextEvents = new Map([...persistedEvents].map(([k, v]) => [k, structuredClone(v)]));
    const results = [];
    for (const statement of statements) {
      const { sql, args } = statement;
      calls.push({ sql, args });
      if (sql.startsWith("DELETE FROM event_templates")) {
        for (const [k, row] of nextTemplates) if (row.user_id === args[0]) nextTemplates.delete(k);
        results.push({ meta: { changes: 1 } });
      } else if (sql.startsWith("INSERT INTO event_templates")) {
        const row = { user_id: args[0], id: args[1], shortcut: args[2], title: args[3], time: args[4], duration_minutes: args[5], recurrence: args[6] };
        nextTemplates.set(key(row.user_id, row.id), row); results.push({ meta: { changes: 1 } });
      } else if (sql.startsWith("INSERT INTO event_batches")) {
        const owner = args[0], batchId = args[1], batchKey = key(owner, batchId), eventIds = JSON.parse(args[5]);
        const hasCollision = eventIds.some(id => nextEvents.has(key(owner, id)));
        if (nextBatches.has(batchKey) || hasCollision) results.push({ meta: { changes: 0 } });
        else { nextBatches.set(batchKey, { user_id: owner, batch_id: batchId, request_hash: args[2], claim_nonce: args[3], status: args[4], event_ids_json: args[5], sync_json: "[]" }); results.push({ meta: { changes: 1 } }); }
      } else if (sql.startsWith("INSERT INTO events") && sql.includes("event_batches")) {
        if (db.failBatchOnEvent) throw new Error("injected transaction failure");
        const owner = args[1], batchKey = key(args[13], args[14]), batch = nextBatches.get(batchKey);
        if (!batch || batch.claim_nonce !== args[15] || nextEvents.has(key(owner, args[0]))) results.push({ meta: { changes: 0 } });
        else { nextEvents.set(key(owner, args[0]), { id: args[0], user_id: owner, title: args[2], start: args[3], end: args[4], timezone: args[5], recurrence: args[6], type: args[7], due_date: args[8], due_time: args[9], completed: args[10], google_event_id: null, synced_at: null }); results.push({ meta: { changes: 1 } }); }
      } else throw new Error(`Unexpected fake D1 batch statement: ${sql}`);
    }
    templates.clear(); for (const entry of nextTemplates) templates.set(...entry);
    batches.clear(); for (const entry of nextBatches) batches.set(...entry);
    persistedEvents.clear(); for (const entry of nextEvents) persistedEvents.set(...entry);
    return results;
  } };
  db.rows = rows;
  db.states = states;
  db.templates = templates;
  db.batches = batches;
  db.persistedEvents = persistedEvents;
  db.failBatchOnEvent = false;
  db.failBatchReceipt = false;
  db.calls = calls;
  db.allRows = [];
  db.appRows = [];
  return db;
}
async function encryptedToken(token) {
  const raw = new Uint8Array(32), key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]), iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64(iv)}.${b64(new Uint8Array(cipher))}`;
}

test("reports local mode when D1 is not bound", async () => {
  const response = await handleApi(new Request("https://app.example/api/status"), {}, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, mode: "local", storage: "unavailable", authenticated: false, accountKey: null, google: { configured: false, connected: false }, ai: "rules" });
});

test("reports an authenticated cloud account independently from Google Calendar consent", async () => {
  const response = await handleApi(new Request("https://app.example/api/status", { headers: { cookie: await cookie() } }), { DB: fakeDb(), APP_SESSION_SECRET: secret }, {});
  const value = await response.json();
  assert.equal(value.authenticated, true);
  assert.equal(value.google.connected, false);
  assert.equal(typeof value.accountKey, "string");
  assert.equal(value.accountKey.length, 16);
  assert.notEqual(value.accountKey, "google-user-1");
});

test("rejects malformed JSON and missing text with structured errors", async () => {
  const badJson = await handleApi(new Request("https://app.example/api/parse", { method: "POST", headers: { origin: "https://app.example" }, body: "{" }), {}, {});
  assert.equal(badJson.status, 400);
  assert.match((await badJson.json()).error, /Malformed JSON/);
  const noText = await handleApi(new Request("https://app.example/api/parse", { method: "POST", headers: { origin: "https://app.example", "content-type": "application/json" }, body: "{}" }), {}, {});
  assert.equal(noText.status, 400);
  const scalar = await handleApi(new Request("https://app.example/api/parse", { method: "POST", headers: { origin: "https://app.example", "content-type": "application/json" }, body: "null" }), {}, {});
  assert.equal(scalar.status, 400);
  assert.match((await scalar.json()).error, /must be an object/);
});

test("caps streamed JSON bodies even when content-length is absent", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ text: "x".repeat(65536) }));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const response = await handleApi(new Request("https://app.example/api/parse", { method: "POST", headers: { origin: "https://app.example", "content-type": "application/json" }, body: stream, duplex: "half" }), {}, {});
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /too large/);
});

test("rules fallback never fabricates a date or start time", async () => {
  const response = await handleApi(new Request("https://app.example/api/parse", { method: "POST", headers: { origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ text: "Check in with Mei sometime next week" }) }), {}, {});
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.mode, "rules");
  assert.equal(value.needsClarification, true);
  assert.equal(value.event, undefined);
});

test("rules parser returns an event only after it finds a start time", async () => {
  const response = await handleApi(new Request("https://app.example/api/parse", { method: "POST", headers: { origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ text: "2026年10月20日 14時 プロジェクト相談", timezone: "Asia/Tokyo" }) }), {}, {});
  const value = await response.json();
  assert.equal(value.mode, "rules");
  assert.equal(value.needsClarification, false);
  assert.equal(value.event.timezone, "Asia/Tokyo");
  assert.equal(Date.parse(value.event.end) - Date.parse(value.event.start), 60 * 60 * 1000);
});

test("AI cannot add a missing start time or replace the rule-checked date", async () => {
  let calls = 0;
  const env = { APP_SESSION_SECRET: secret, AI: { async run() { calls++; return { response: JSON.stringify({ title: "Invented", start: "2032-04-05T09:00:00+09:00", end: null }) }; } } };
  const missing = await handleApi(new Request("https://app.example/api/parse", { method: "POST", headers: { origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ text: "来週、プロジェクト相談", timezone: "Asia/Tokyo" }) }), env, {});
  assert.equal((await missing.json()).needsClarification, true);
  assert.equal(calls, 0);
  const anonymous = await handleApi(new Request("https://app.example/api/parse", { method: "POST", headers: { origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ text: "2026年10月20日 14時 プロジェクト相談", timezone: "Asia/Tokyo" }) }), env, {});
  assert.equal((await anonymous.json()).mode, "rules");
  assert.equal(calls, 0);
  const response = await handleApi(new Request("https://app.example/api/parse", { method: "POST", headers: { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ text: "2026年10月20日 14時 プロジェクト相談", timezone: "Asia/Tokyo" }) }), env, {});
  const result = await response.json();
  assert.equal(result.mode, "rules");
  assert.equal(calls, 1);
  assert.equal(result.event.title, "プロジェクト相談");
  assert.equal(result.event.start, "2026-10-20T05:00:00.000Z");
});

test("authenticated AI can refine a Japanese title but cannot change validated temporal fields", async () => {
  let prompt = "";
  const env = { APP_SESSION_SECRET: secret, AI: { async run(_model, input) {
    prompt = input.prompt;
    return { response: JSON.stringify({ title: "山田さんと新商品の見積もり相談", start: "2026-10-20T14:00:00+09:00", end: "2030-01-01T00:00:00Z", timezone: "UTC", recurrence: ["RRULE:FREQ=DAILY"] }) };
  } } };
  const response = await handleApi(new Request("https://app.example/api/parse", {
    method: "POST",
    headers: { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" },
    body: JSON.stringify({ text: "2026年10月20日 14時、山田さんに新商品の見積もりを相談する約束", timezone: "Asia/Tokyo" }),
  }), env, {});
  const result = await response.json();
  assert.equal(result.mode, "ai");
  assert.equal(result.event.title, "山田さんと新商品の見積もり相談");
  assert.equal(result.event.start, "2026-10-20T05:00:00.000Z");
  assert.equal(result.event.end, "2026-10-20T06:00:00.000Z");
  assert.equal(result.event.timezone, "Asia/Tokyo");
  assert.deepEqual(result.event.recurrence, []);
  assert.match(prompt, /現在日時は .*（UTC）/);
  assert.match(prompt, /検証済みの予定情報/);
  assert.match(prompt, /Asia\/Tokyo/);
  assert.match(prompt, /2026-10-20T05:00:00\.000Z/);
});

test("authenticated event routes validate required explicit start and isolate by session", async () => {
  const db = fakeDb(), env = { DB: db, APP_SESSION_SECRET: secret };
  const request = new Request("https://app.example/api/events", { method: "POST", headers: { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ event: { title: "Review", start: "not a date" } }) });
  const invalid = await handleApi(request, env, {});
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /valid start/);
  const unauthenticated = await handleApi(new Request("https://app.example/api/events"), env, {});
  assert.equal(unauthenticated.status, 401);
  const malformedCookie = await handleApi(new Request("https://app.example/api/events", { headers: { cookie: "memo_session=%%%.__" } }), env, {});
  assert.equal(malformedCookie.status, 401);
});

test("mutations reject a cross-origin request before touching storage", async () => {
  const response = await handleApi(new Request("https://app.example/api/events", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }), { DB: fakeDb() }, {});
  assert.equal(response.status, 403);
});

test("event creation gives an omitted end a one-hour default", async () => {
  const db = fakeDb(), env = { DB: db, APP_SESSION_SECRET: secret };
  const response = await handleApi(new Request("https://app.example/api/events", { method: "POST", headers: { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ event: { title: "Planning", start: "2026-10-18T12:00:00Z" } }) }), env, {});
  assert.equal(response.status, 201);
  const event = (await response.json()).event;
  assert.equal(event.end, "2026-10-18T13:00:00.000Z");
  assert.ok(event.id);
  const retry = await handleApi(new Request("https://app.example/api/events", { method: "POST", headers: { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ event: { id: event.id, title: "Planning", start: event.start } }) }), env, {});
  assert.equal(retry.status, 201);
  assert.match(db.calls.at(-1).sql, /ON CONFLICT\(user_id,id\) DO UPDATE/);
});

test("saved templates are validated, account-scoped, and supplied to the server parser", async () => {
  const db = fakeDb(), env = { DB: db, APP_SESSION_SECRET: secret, AI: { async run() { throw new Error("template expansion must not use AI"); } } };
  const headers = { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" };
  const templates = [
    { id: "shift-17", shortcut: "①", title: "バイト", time: "17:00", durationMinutes: 240, recurrence: null },
    { id: "shift-21", shortcut: "②", title: "バイト", time: "21:00", durationMinutes: 180, recurrence: null },
  ];
  const save = await handleApi(new Request("https://app.example/api/templates", { method: "PUT", headers, body: JSON.stringify({ templates }) }), env, {});
  assert.equal(save.status, 200);
  assert.deepEqual((await save.json()).templates, templates);
  const invalid = await handleApi(new Request("https://app.example/api/templates", { method: "PUT", headers, body: JSON.stringify({ templates: [{ ...templates[0], time: "25:00" }] }) }), env, {});
  assert.equal(invalid.status, 400);
  assert.equal((await handleApi(new Request("https://app.example/api/templates"), env, {})).status, 401);
  const otherUser = await handleApi(new Request("https://app.example/api/templates", { headers: { cookie: await cookie("another-user") } }), env, {});
  assert.deepEqual((await otherUser.json()).templates, []);

  const get = await handleApi(new Request("https://app.example/api/templates", { headers: { cookie: await cookie() } }), env, {});
  assert.deepEqual((await get.json()).templates, templates);
  const parse = await handleApi(new Request("https://app.example/api/parse", { method: "POST", headers, body: JSON.stringify({ text: "来週火曜①", timezone: "Asia/Tokyo" }) }), env, {});
  const result = await parse.json();
  assert.equal(result.mode, "rules");
  assert.equal(result.events.length, 1);
  assert.equal(result.event.title, "バイト");
  assert.equal(result.event.start, result.events[0].start);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(result.event.start));
  assert.equal(`${parts.find(x => x.type === "hour").value}:${parts.find(x => x.type === "minute").value}`, "17:00");
  const second = await handleApi(new Request("https://app.example/api/parse", { method: "POST", headers, body: JSON.stringify({ text: "来週火曜②", timezone: "Asia/Tokyo" }) }), env, {});
  assert.equal((await second.json()).event.start.slice(11, 16), "12:00", "UTC representation of 21:00 JST is 12:00Z");
});

test("server parse preserves every weekday in a batch and does not send batches through AI", async () => {
  let aiCalls = 0;
  const env = { DB: fakeDb(), APP_SESSION_SECRET: secret, AI: { async run() { aiCalls++; return { response: "{}" }; } } };
  const response = await handleApi(new Request("https://app.example/api/parse", { method: "POST", headers: { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ text: "来週の火曜と水曜と土曜日に17時からバイト", timezone: "Asia/Tokyo" }) }), env, {});
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.needsClarification, false);
  assert.equal(result.mode, "rules");
  assert.equal(result.events.length, 3);
  assert.equal(result.event, undefined, "multi-event responses do not collapse to one legacy event");
  assert.deepEqual(result.events.map(event => event.title), ["バイト", "バイト", "バイト"]);
  assert.equal(new Set(result.events.map(event => event.start.slice(0, 10))).size, 3);
  assert.equal(aiCalls, 0);
});

test("server parse and atomic batch preserve two explicit date/time pairs with one shared title", async () => {
  let aiCalls = 0;
  const db = fakeDb(), env = { DB: db, APP_SESSION_SECRET: secret, AI: { async run() { aiCalls++; return { response: JSON.stringify({ title: "Collapsed AI result", start: "2026-10-29T01:00:00Z" }) }; } } };
  const headers = { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" };
  const parsedResponse = await handleApi(new Request("https://app.example/api/parse", {
    method: "POST", headers,
    body: JSON.stringify({ text: "10/29 10:00と11/5 14:00 ワンキャリア", timezone: "Asia/Tokyo" }),
  }), env, {});
  assert.equal(parsedResponse.status, 200);
  const parsed = await parsedResponse.json();
  assert.equal(parsed.needsClarification, false);
  assert.equal(parsed.mode, "rules", "multi-date parse bypasses singleton AI title refinement");
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.event, undefined);
  assert.deepEqual(parsed.events.map(event => event.title), ["ワンキャリア", "ワンキャリア"]);
  assert.deepEqual(parsed.events.map(event => event.start), ["2026-10-29T01:00:00.000Z", "2026-11-05T05:00:00.000Z"]);
  assert.deepEqual(parsed.events.map(event => event.end), ["2026-10-29T02:00:00.000Z", "2026-11-05T06:00:00.000Z"]);
  assert.equal(aiCalls, 0, "AI cannot collapse two verified date/time pairs into one event");

  const batchResponse = await handleApi(new Request("https://app.example/api/events/batch", {
    method: "POST", headers,
    body: JSON.stringify({ batchId: "onecareer-two-dates", events: parsed.events.map((event, index) => ({ ...event, id: `onecareer-${index + 1}` })), autoSync: false }),
  }), env, {});
  assert.equal(batchResponse.status, 201);
  const saved = await batchResponse.json();
  assert.deepEqual(saved.events.map(event => event.title), ["ワンキャリア", "ワンキャリア"]);
  assert.deepEqual(saved.events.map(event => event.start), ["2026-10-29T01:00:00.000Z", "2026-11-05T05:00:00.000Z"]);
  assert.deepEqual(saved.events.map(event => event.end), ["2026-10-29T02:00:00.000Z", "2026-11-05T06:00:00.000Z"]);
  assert.equal(db.persistedEvents.size, 2);
});

test("an invalid second date pair cannot produce or persist a partial first schedule", async () => {
  let aiCalls = 0;
  const db = fakeDb(), env = { DB: db, APP_SESSION_SECRET: secret, AI: { async run() { aiCalls++; return { response: "{}" }; } } };
  const headers = { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" };
  const parsedResponse = await handleApi(new Request("https://app.example/api/parse", { method: "POST", headers, body: JSON.stringify({ text: "10/29 10:00と11/35 14:00 ワンキャリア", timezone: "Asia/Tokyo" }) }), env, {});
  const parsed = await parsedResponse.json();
  assert.equal(parsed.needsClarification, true);
  assert.equal(parsed.event, undefined);
  assert.equal(parsed.events, undefined);
  assert.equal(aiCalls, 0);

  const batch = await handleApi(new Request("https://app.example/api/events/batch", { method: "POST", headers, body: JSON.stringify({ batchId: "invalid-pair-batch", events: [
    { id: "valid-first", title: "ワンキャリア", start: "2026-10-29T01:00:00Z" },
    { id: "invalid-second", title: "ワンキャリア", start: "not-a-date" },
  ] }) }), env, {});
  assert.equal(batch.status, 400);
  assert.equal(db.persistedEvents.size, 0);
  assert.equal(db.batches.size, 0, "validation completes before the atomic D1 batch begins");
});

test("batch schedule creation is atomic and idempotent per account and payload", async () => {
  const db = fakeDb(), env = { DB: db, APP_SESSION_SECRET: secret };
  const headers = { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" };
  const body = { batchId: "batch-20261021-1", autoSync: false, events: [
    { id: "batch-tue", title: "バイト", start: "2026-10-27T08:00:00Z", end: "2026-10-27T12:00:00Z", timezone: "Asia/Tokyo" },
    { id: "batch-wed", title: "バイト", start: "2026-10-28T08:00:00Z", end: "2026-10-28T12:00:00Z", timezone: "Asia/Tokyo" },
    { id: "batch-sat", title: "バイト", start: "2026-10-31T08:00:00Z", end: "2026-10-31T12:00:00Z", timezone: "Asia/Tokyo" },
  ] };
  const created = await handleApi(new Request("https://app.example/api/events/batch", { method: "POST", headers, body: JSON.stringify(body) }), env, {});
  assert.equal(created.status, 201);
  const first = await created.json();
  assert.equal(first.events.length, 3);
  assert.equal(first.status, "complete");
  assert.deepEqual(first.syncResults.map(item => item.status), ["not-requested", "not-requested", "not-requested"]);
  assert.equal(db.persistedEvents.size, 3);

  const replay = await handleApi(new Request("https://app.example/api/events/batch", { method: "POST", headers, body: JSON.stringify(body) }), env, {});
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(db.persistedEvents.size, 3, "retries do not duplicate event rows");

  const differentPayload = structuredClone(body); differentPayload.events[0].title = "Different";
  const conflict = await handleApi(new Request("https://app.example/api/events/batch", { method: "POST", headers, body: JSON.stringify(differentPayload) }), env, {});
  assert.equal(conflict.status, 409);
  const otherAccount = await handleApi(new Request("https://app.example/api/events/batch", { method: "POST", headers: { ...headers, cookie: await cookie("another-user") }, body: JSON.stringify(body) }), env, {});
  assert.equal(otherAccount.status, 201, "same ids in a different account are isolated by composite ownership keys");
  assert.equal(db.persistedEvents.size, 6);
  const colliding = await handleApi(new Request("https://app.example/api/events/batch", { method: "POST", headers, body: JSON.stringify({ batchId: "collision-batch", events: [
    { id: "batch-tue", title: "Would overwrite", start: "2026-11-03T08:00:00Z" },
    { id: "batch-extra", title: "Would partially save", start: "2026-11-04T08:00:00Z" },
  ] }) }), env, {});
  assert.equal(colliding.status, 409);
  assert.equal(db.persistedEvents.size, 6, "a collision on one id prevents every write in the batch");
});

test("batch schedule writes reject task or duplicate ids and roll back completely on D1 failure", async () => {
  const db = fakeDb(), env = { DB: db, APP_SESSION_SECRET: secret }, headers = { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" };
  const event = (id) => ({ id, title: "Work", start: "2026-10-27T08:00:00Z", end: "2026-10-27T09:00:00Z", timezone: "Asia/Tokyo" });
  for (const events of [[event("same"), event("same")], [{ ...event("task-in-batch"), type: "task" }]]) {
    const response = await handleApi(new Request("https://app.example/api/events/batch", { method: "POST", headers, body: JSON.stringify({ batchId: "invalid-batch", events }) }), env, {});
    assert.equal(response.status, 400);
    assert.equal(db.persistedEvents.size, 0);
  }
  db.failBatchOnEvent = true;
  const failed = await handleApi(new Request("https://app.example/api/events/batch", { method: "POST", headers, body: JSON.stringify({ batchId: "rollback-batch", events: [event("rollback-one"), event("rollback-two")] }) }), env, {});
  assert.equal(failed.status, 409);
  assert.equal(db.persistedEvents.size, 0);
  assert.equal(db.batches.size, 0, "failed D1.batch rolls back the claim and all earlier event inserts");
});

test("a replay after a durable-save/receipt interruption returns saved events with unknown sync status", async () => {
  const db = fakeDb(), env = { DB: db, APP_SESSION_SECRET: secret };
  const headers = { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" };
  const body = { batchId: "receipt-recovery", autoSync: true, events: [{ id: "receipt-shift", title: "バイト", start: "2026-10-27T08:00:00Z", end: "2026-10-27T09:00:00Z", timezone: "Asia/Tokyo" }] };
  db.failBatchReceipt = true;
  const first = await handleApi(new Request("https://app.example/api/events/batch", { method: "POST", headers, body: JSON.stringify(body) }), env, {});
  assert.equal(first.status, 207, "the original response truthfully reports failed calendar sync");
  assert.equal(db.batches.get("google-user-1\0receipt-recovery").status, "pending");
  const retry = await handleApi(new Request("https://app.example/api/events/batch", { method: "POST", headers, body: JSON.stringify(body) }), env, {});
  assert.equal(retry.status, 200);
  const result = await retry.json();
  assert.equal(result.replayed, true);
  assert.equal(result.events.length, 1);
  assert.equal(result.sync.status, "unknown");
  assert.deepEqual(result.syncResults, [{ id: "receipt-shift", status: "unknown" }]);
  assert.equal(db.persistedEvents.size, 1);
});

test("batch reports each Google failure and never claims a full sync", async () => {
  const db = fakeDb(), env = { DB: db, APP_SESSION_SECRET: secret };
  const headers = { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" };
  const response = await handleApi(new Request("https://app.example/api/events/batch", { method: "POST", headers, body: JSON.stringify({ batchId: "sync-partial", autoSync: true, events: [
    { id: "sync-one", title: "Shift 1", start: "2026-10-27T08:00:00Z", end: "2026-10-27T09:00:00Z" },
    { id: "sync-two", title: "Shift 2", start: "2026-10-28T08:00:00Z", end: "2026-10-28T09:00:00Z" },
  ] }) }), env, {});
  assert.equal(response.status, 207);
  const result = await response.json();
  assert.equal(result.ok, false);
  assert.equal(result.sync.status, "partial");
  assert.deepEqual(result.syncResults.map(item => [item.id, item.status]), [["sync-one", "failed"], ["sync-two", "failed"]]);
  assert.equal(result.events.length, 2, "D1 schedules are durable even when Google sync fails");
});

test("tasks require a real due date, accept optional 24-hour time, and never autosync to Google", async () => {
  const db = fakeDb(), env = { DB: db, APP_SESSION_SECRET: secret };
  const invalidDate = await handleApi(new Request("https://app.example/api/events", { method: "POST", headers: { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ autoSync: true, event: { type: "task", title: "Task", dueDate: "2026-02-30", dueTime: null } }) }), env, {});
  assert.equal(invalidDate.status, 400);
  const invalidTime = await handleApi(new Request("https://app.example/api/events", { method: "POST", headers: { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ event: { type: "task", title: "Task", dueDate: "2026-10-20", dueTime: "25:00" } }) }), env, {});
  assert.equal(invalidTime.status, 400);
  assert.equal(db.calls.length, 0);
  const response = await handleApi(new Request("https://app.example/api/events", { method: "POST", headers: { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ autoSync: true, event: { id: "task-jst", type: "task", title: "Submit application", dueDate: "2026-10-20", dueTime: "15:30", timezone: "Asia/Tokyo" } }) }), env, {});
  assert.equal(response.status, 201);
  const value = await response.json();
  assert.equal(value.event.type, "task");
  assert.equal(value.event.dueDate, "2026-10-20");
  assert.equal(value.event.dueTime, "15:30");
  assert.equal(value.event.completed, false);
  assert.equal(value.event.start, "2026-10-20T06:30:00.000Z");
  assert.equal(value.event.end, "2026-10-20T06:31:00.000Z");
  assert.equal(value.sync.status, "not-applicable");
  assert.equal(db.calls.length, 1, "task creation only writes its account-scoped D1 row");
  assert.match(db.calls[0].sql, /due_date,due_time,completed/);
  assert.equal(db.calls[0].args[1], "google-user-1");
  assert.equal(db.calls[0].args[7], "task");
  assert.equal(db.calls[0].args[8], "2026-10-20");
  assert.equal(db.calls[0].args[9], "15:30");
  assert.equal(db.calls[0].args[10], 0);
});

test("task due dates stay on their selected local calendar day in UTC+14 and reject nonexistent DST times", async () => {
  const db = fakeDb(), env = { DB: db, APP_SESSION_SECRET: secret };
  const headers = { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" };
  const localNoon = await handleApi(new Request("https://app.example/api/events", {
    method: "POST", headers,
    body: JSON.stringify({ event: { id: "task-kiritimati", type: "task", title: "Due today", dueDate: "2026-10-20", timezone: "Pacific/Kiritimati" } }),
  }), env, {});
  assert.equal(localNoon.status, 201);
  const saved = await localNoon.json();
  assert.equal(saved.event.dueDate, "2026-10-20");
  assert.equal(saved.event.start, "2026-10-19T22:00:00.000Z", "local noon in UTC+14 is still Oct 20 locally");

  const nonexistent = await handleApi(new Request("https://app.example/api/events", {
    method: "POST", headers,
    body: JSON.stringify({ event: { type: "task", title: "DST gap", dueDate: "2026-03-08", dueTime: "02:30", timezone: "America/Los_Angeles" } }),
  }), env, {});
  assert.equal(nonexistent.status, 400);
  assert.match((await nonexistent.json()).error, /does not exist/);
  assert.equal(db.calls.length, 1, "invalid wall time is rejected before persistence");
});

test("task CRUD and selected sync never call Google Calendar, even when autosync is requested", async () => {
  const db = fakeDb(), userCookie = await cookie();
  db.allRows = [{ id: "task-never-sync", title: "Submit report", start: "2026-10-20T03:00:00.000Z", end: "2026-10-20T03:01:00.000Z", timezone: "Asia/Tokyo", recurrence: "[]", type: "task", due_date: "2026-10-20", due_time: null, completed: 0, google_event_id: null }];
  const env = { DB: db, APP_SESSION_SECRET: secret, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url") };
  let outbound = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { outbound++; throw new Error("tasks must not reach Google Calendar"); };
  try {
    const create = await handleApi(new Request("https://app.example/api/events", { method: "POST", headers: { cookie: userCookie, origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ autoSync: true, event: { id: "task-never-sync", type: "task", title: "Submit report", dueDate: "2026-10-20", timezone: "Asia/Tokyo" } }) }), env, {});
    assert.equal(create.status, 201);
    assert.equal((await create.json()).sync.status, "not-applicable");
    const update = await handleApi(new Request("https://app.example/api/events/task-never-sync", { method: "PUT", headers: { cookie: userCookie, origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ autoSync: true, event: { type: "task", title: "Submit final report", dueDate: "2026-10-20", completed: true, timezone: "Asia/Tokyo" } }) }), env, {});
    assert.equal(update.status, 200);
    assert.equal((await update.json()).sync.status, "not-applicable");
    const sync = await handleApi(new Request("https://app.example/api/google/sync", { method: "POST", headers: { cookie: userCookie, origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ eventIds: ["task-never-sync"] }) }), env, {});
    assert.equal(sync.status, 200);
    assert.equal((await sync.json()).skippedTasks, 1);
    assert.equal(outbound, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test("task completion updates are account-owned and task selection is skipped by calendar sync", async () => {
  const db = fakeDb(), env = { DB: db, APP_SESSION_SECRET: secret };
  db.allRows = [{ id: "task-toggle", user_id: "google-user-1", title: "Read", start: "2026-10-20T03:00:00.000Z", end: "2026-10-20T03:01:00.000Z", timezone: "Asia/Tokyo", recurrence: "[]", type: "task", due_date: "2026-10-20", due_time: null, completed: 0, google_event_id: null, synced_at: null }];
  const update = await handleApi(new Request("https://app.example/api/events/task-toggle", { method: "PUT", headers: { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ autoSync: true, event: { type: "task", title: "Read", dueDate: "2026-10-20", dueTime: null, timezone: "Asia/Tokyo", completed: true } }) }), env, {});
  assert.equal(update.status, 200);
  const updated = await update.json();
  assert.equal(updated.event.completed, true);
  assert.equal(updated.sync.status, "not-applicable");
  assert.match(db.calls.at(-1).sql, /completed=COALESCE\(\?,completed\).*type=\?/);
  assert.equal(db.calls.at(-1).args[7], 1);
  assert.equal(db.calls.at(-1).args.at(-1), "task");
  const sync = await handleApi(new Request("https://app.example/api/google/sync", { method: "POST", headers: { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ eventIds: ["task-toggle"] }) }), env, {});
  assert.equal(sync.status, 200);
  const summary = await sync.json();
  assert.equal(summary.skippedTasks, 1);
  assert.equal(summary.created, 0);
  assert.equal(summary.updated, 0);
  assert.equal(summary.failed, 0);
});

test("GET events returns task fields and defaults legacy rows to schedules", async () => {
  const db = fakeDb(), env = { DB: db, APP_SESSION_SECRET: secret };
  db.allRows = [
    { id: "task-read", user_id: "google-user-1", title: "Read", start: "2026-10-20T03:00:00.000Z", end: "2026-10-20T03:01:00.000Z", timezone: "Asia/Tokyo", recurrence: "[]", type: "task", due_date: "2026-10-20", due_time: null, completed: 1, google_event_id: null, synced_at: null },
    { id: "old-schedule", user_id: "google-user-1", title: "Meeting", start: "2026-10-20T05:00:00.000Z", end: "2026-10-20T06:00:00.000Z", timezone: "Asia/Tokyo", recurrence: "[]", google_event_id: null, synced_at: null },
  ];
  const response = await handleApi(new Request("https://app.example/api/events", { headers: { cookie: await cookie() } }), env, {});
  assert.equal(response.status, 200);
  const events = (await response.json()).events;
  assert.equal(events[0].type, "task");
  assert.equal(events[0].dueDate, "2026-10-20");
  assert.equal(events[0].dueTime, null);
  assert.equal(events[0].completed, true);
  assert.equal(events[1].type, "schedule");
  assert.equal(events[1].completed, false);
});

test("autoSync reports a missing Google grant as a partial failure", async () => {
  const db = fakeDb(), env = { DB: db, APP_SESSION_SECRET: secret };
  const response = await handleApi(new Request("https://app.example/api/events", { method: "POST", headers: { cookie: await cookie(), origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ autoSync: true, event: { title: "Planning", start: "2026-10-18T12:00:00Z" } }) }), env, {});
  assert.equal(response.status, 207);
  const value = await response.json();
  assert.equal(value.ok, false);
  assert.equal(value.sync.status, "failed");
  assert.match(value.sync.message, /not connected/);
});

test("Google event import requires auth and a bounded RFC3339 window", async () => {
  let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected network request"); };
  try {
    const env = { APP_SESSION_SECRET: secret, DB: fakeDb() };
    const unauth = await handleApi(new Request("https://app.example/api/google/events?timeMin=2026-10-19T00:00:00Z&timeMax=2026-10-26T00:00:00Z"), env, {});
    assert.equal(unauth.status, 401);
    const malformed = await handleApi(new Request("https://app.example/api/google/events?timeMin=next-week&timeMax=2026-10-26T00:00:00Z", { headers: { cookie: await cookie() } }), env, {});
    assert.equal(malformed.status, 400);
    const impossibleDate = await handleApi(new Request("https://app.example/api/google/events?timeMin=2026-02-30T00:00:00Z&timeMax=2026-03-01T00:00:00Z", { headers: { cookie: await cookie() } }), env, {});
    assert.equal(impossibleDate.status, 400);
    const tooWide = await handleApi(new Request("https://app.example/api/google/events?timeMin=2026-01-01T00:00:00Z&timeMax=2026-06-01T00:00:00Z", { headers: { cookie: await cookie() } }), env, {});
    assert.equal(tooWide.status, 400);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test("Google import expands pages, deduplicates owned app events, and returns live overrides", async () => {
  const db = fakeDb();
  db.rows.set("google-user-1", { access_token_enc: await encryptedToken("calendar-access"), access_expires: Date.now() + 3600_000 });
  db.appRows = [
    { id: "app-edit", title: "Old title", start: "2026-10-20T05:00:00.000Z", end: "2026-10-20T06:00:00.000Z", timezone: "Asia/Tokyo", recurrence: "[]", google_event_id: "app-google-id" },
    { id: "app-weekly", title: "Weekly", start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T02:00:00.000Z", timezone: "UTC", recurrence: '["RRULE:FREQ=WEEKLY;BYDAY=TU"]', google_event_id: "weekly-master-id" },
    { id: "app-deleted", title: "Deleted externally", start: "2026-10-22T01:00:00.000Z", end: "2026-10-22T02:00:00.000Z", timezone: "UTC", recurrence: "[]", google_event_id: "deleted-google-id" },
  ];
  const requested = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    requested.push({ url: new URL(input), init });
    const page = new URL(input).searchParams.get("pageToken");
    const items = page ? [
      { id: "external-recurring-instance", summary: "Piano class", start: { dateTime: "2026-10-24T10:00:00+09:00", timeZone: "Asia/Tokyo" }, end: { dateTime: "2026-10-24T11:00:00+09:00", timeZone: "Asia/Tokyo" }, recurringEventId: "external-series", originalStartTime: { dateTime: "2026-10-24T10:00:00+09:00", timeZone: "Asia/Tokyo" } },
      { id: "external-all-day", summary: "Holiday", start: { date: "2026-10-25" }, end: { date: "2026-10-26" } },
    ] : [
      { id: "external-one", summary: "Team meeting", start: { dateTime: "2026-10-20T09:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-20T10:00:00Z", timeZone: "UTC" } },
      { id: "app-google-id", summary: "Calendar-edited title", start: { dateTime: "2026-10-20T06:00:00Z", timeZone: "Asia/Tokyo" }, end: { dateTime: "2026-10-20T07:30:00Z", timeZone: "Asia/Tokyo" } },
      { id: "weekly-instance", summary: "Weekly", start: { dateTime: "2026-10-20T10:00:00Z" }, end: { dateTime: "2026-10-20T11:00:00Z" }, recurringEventId: "weekly-master-id", originalStartTime: { dateTime: "2026-10-20T10:00:00Z" } },
      { id: "unowned-private-marker", summary: "Personal appointment", start: { dateTime: "2026-10-21T10:00:00Z" }, end: { dateTime: "2026-10-21T11:00:00Z" }, extendedProperties: { private: { memoCalendarId: "deleted-app-id" } } },
      { id: "deleted-google-id", status: "cancelled" },
    ];
    return new Response(JSON.stringify({ items, ...(page ? {} : { nextPageToken: "page-2" }) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await handleApi(new Request("https://app.example/api/google/events?timeMin=2026-10-19T00:00:00Z&timeMax=2026-10-26T00:00:00Z", { headers: { cookie: await cookie() } }), { APP_SESSION_SECRET: secret, DB: db, TOKEN_ENCRYPTION_KEY: "A".repeat(43) }, {});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(requested.length, 2);
    assert.equal(requested[0].init.headers.authorization, "Bearer calendar-access");
    assert.equal(requested[0].url.searchParams.get("singleEvents"), "true");
    assert.equal(requested[0].url.searchParams.get("orderBy"), "startTime");
    assert.equal(requested[1].url.searchParams.get("pageToken"), "page-2");
    assert.equal(result.events.some(event => event.googleEventId === "app-google-id"), false);
    assert.equal(result.events.some(event => event.googleEventId === "weekly-instance"), false);
    assert.equal(result.events.some(event => event.googleEventId === "unowned-private-marker"), true);
    const imported = result.events.find(event => event.googleEventId === "external-one");
    assert.equal(imported.source, "google");
    assert.equal(imported.readOnly, true);
    const recurring = result.events.find(event => event.googleEventId === "external-recurring-instance");
    assert.equal(recurring.recurringEventId, "external-series");
    assert.equal(recurring.originalStartTime.dateTime, "2026-10-24T10:00:00+09:00");
    const allDay = result.events.find(event => event.googleEventId === "external-all-day");
    assert.equal(allDay.allDay, true);
    assert.equal(allDay.start, "2026-10-25");
    assert.equal(allDay.end, "2026-10-26");
    const override = result.appEventOverrides.find(event => event.id === "app-edit");
    assert.equal(override.title, "Calendar-edited title");
    assert.equal(override.start, "2026-10-20T06:00:00.000Z");
    assert.equal(override.end, "2026-10-20T07:30:00.000Z");
    assert.equal(override.liveOverride, true);
    assert.equal(result.appEventOverrides.find(event => event.id === "app-deleted").deleted, true);
    assert.equal(result.appEventOverrides.find(event => event.id === "app-weekly"), undefined);
    assert.equal(db.calls.length, 0, "inbound import does not mutate or persist calendar events");
  } finally { globalThis.fetch = previousFetch; }
});

test("Calendar sync uses a deterministic Google event ID across retries", async () => {
  const db = fakeDb(), userCookie = await cookie(), rawKey = Buffer.alloc(32).toString("base64url"), now = Date.now();
  db.rows.set("google-user-1", { refresh_token_enc: await encryptedToken("refresh"), access_token_enc: await encryptedToken("access"), access_expires: now + 3600000 });
  db.allRows = [{ id: "repeat-03", title: "Class 3", start: "2026-10-20T05:00:00.000Z", end: "2026-10-20T06:00:00.000Z", timezone: "Asia/Tokyo", recurrence: "[]", google_event_id: null }];
  const env = { DB: db, APP_SESSION_SECRET: secret, TOKEN_ENCRYPTION_KEY: rawKey };
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method });
    if (init.method === "PATCH" && calls.filter(x => x.method === "PATCH").length === 1) return new Response("{}", { status: 404 });
    return new Response("{}", { status: init.method === "PATCH" ? 200 : 201 });
  };
  try {
    for (let i = 0; i < 2; i++) {
      const response = await handleApi(new Request("https://app.example/api/google/sync", { method: "POST", headers: { cookie: userCookie, origin: "https://app.example", "content-type": "application/json" }, body: "{}" }), env, {});
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
    }
    const ids = calls.filter(x => x.method === "PATCH").map(x => new URL(x.url).pathname.split("/").at(-1));
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    assert.match(ids[0], /^[a-f0-9]{40}$/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Sites identity is trusted only when explicitly enabled and allows D1 event ownership", async () => {
  const db = fakeDb();
  const request = new Request("https://app.example/api/events", { method: "POST", headers: { "oai-authenticated-user-id": "site-user-42", origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ event: { id: "repeat-2", title: "Class 2", start: "2026-10-19T10:00:00Z", recurrence: [] } }) });
  const blocked = await handleApi(request.clone(), { DB: db }, {});
  assert.equal(blocked.status, 401);
  const accepted = await handleApi(request, { DB: db, TRUST_SITES_IDENTITY: "true" }, {});
  assert.equal(accepted.status, 201);
  assert.equal(db.calls.at(-1).args[1], "site:site-user-42");
});

test("OAuth connect binds state to an HttpOnly browser cookie", async () => {
  const env = { DB: fakeDb(), TRUST_SITES_IDENTITY: "true", APP_ORIGIN: "https://app.example", GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url") };
  const response = await handleApi(new Request("https://app.example/api/google/connect", { headers: { "oai-authenticated-user-id": "site-user-42" } }), env, {});
  assert.equal(response.status, 302);
  const state = new URL(response.headers.get("location")).searchParams.get("state");
  assert.ok(state);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  const oauthCookie = response.headers.get("set-cookie").split(";")[0];
  const callback = await handleApi(new Request(`https://app.example/api/google/callback?state=${state}&code=not-a-real-code`), env, {});
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get("location"), /google=error/);
  assert.match(callback.headers.get("set-cookie"), /Max-Age=0/);
  const wrongSiteUser = await handleApi(new Request(`https://app.example/api/google/callback?state=${state}&code=not-a-real-code`, { headers: { cookie: oauthCookie, "oai-authenticated-user-id": "site-user-else" } }), env, {});
  assert.match(wrongSiteUser.headers.get("location"), /google=error/);
});
