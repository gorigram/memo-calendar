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
  const rows = new Map(), states = new Map(), calls = [];
  const db = { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; }, async first() { if (sql.includes("google_tokens")) return rows.get(args[0]) || null; if (sql.includes("oauth_states")) return states.get(args[0]) || null; return null; }, async all() { if (sql.includes("SELECT id,title,start,end,timezone,recurrence,google_event_id FROM events")) return { results: db.appRows }; return { results: db.allRows }; }, async run() { calls.push({ sql, args }); if (sql.includes("INSERT INTO oauth_states")) states.set(args[0], { code_verifier: args[1], expires_at: args[2], owner_id: args[3] }); if (sql.includes("DELETE FROM oauth_states")) states.delete(args[0]); return { meta: { changes: 1 } }; } }; } };
  db.rows = rows;
  db.states = states;
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
