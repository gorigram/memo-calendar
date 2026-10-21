import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { test } from "node:test";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const wranglerCli = resolve(projectRoot, "node_modules/wrangler/bin/wrangler.js");
const outDir = resolve(projectRoot, ".wrangler/production-regression");

test("Wrangler production bundle serves a page whose embedded parser runs independently", async () => {
  const configHome = resolve(projectRoot, ".wrangler/auth-home");
  const logPath = resolve(projectRoot, ".wrangler/logs");
  await Promise.all([
    mkdir(configHome, { recursive: true }),
    mkdir(logPath, { recursive: true }),
  ]);

  const result = spawnSync(process.execPath, [wranglerCli, "deploy", "--dry-run", "--outdir", outDir], {
    cwd: projectRoot,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      WRANGLER_LOG_PATH: logPath,
      WRANGLER_SEND_METRICS: "false",
    },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const bundlePath = resolve(outDir, "index.js");
  const bundleStat = await stat(bundlePath);
  const workerModule = await import(`${pathToFileURL(bundlePath).href}?mtime=${bundleStat.mtimeMs}-${bundleStat.size}`);
  assert.equal(typeof workerModule.default?.fetch, "function");

  const response = await workerModule.default.fetch(new Request("https://memo-calendar.local/"), {}, { waitUntil() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>ゴレンダー — 予定メモ<\/title>/);
  assert.match(html, /id="googleRefreshButton"/);
  assert.match(html, /id="googleImportStatus"/);
  assert.match(html, /id="taskMode"/);
  assert.match(html, /id="scheduleMode"/);
  assert.doesNotMatch(html, />undefined<\/svg>/);
  const inlineScripts = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
    .filter(([, attributes]) => !/\bsrc\s*=/.test(attributes))
    .filter(([, attributes]) => {
      const type = attributes.match(/\btype\s*=\s*["']?([^\s"'>]+)/i)?.[1]?.toLowerCase();
      return !type || ["text/javascript", "application/javascript", "module"].includes(type);
    });
  assert.ok(inlineScripts.length >= 1, "page contains inline JavaScript");
  for (const [index, [, , source]] of inlineScripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(source, { filename: `inline-client-${index + 1}.js` }), `inline script ${index + 1} compiles`);
  }
  const parserScript = inlineScripts[0]?.[2];
  assert.ok(parserScript, "page contains the embedded parser script");

  const context = { window: {} };
  vm.runInNewContext(parserScript, context, { timeout: 1_000 });
  assert.equal(typeof context.window.michiParser, "function");
  assert.equal(typeof context.window.michiTaskParser, "function");
  const task = context.window.michiTaskParser("明日 申込書を出す", new Date("2026-10-18T00:00:00.000Z"), "Asia/Tokyo");
  assert.equal(task.ok, true);
  assert.equal(task.event.type, "task");
  assert.equal(task.event.dueDate, "2026-10-19");
  assert.equal(task.event.dueTime, null);
  assert.equal(context.window.michiTaskParser("14時 申込書を出す", new Date("2026-10-18T00:00:00.000Z"), "Asia/Tokyo").reason, "missing-date");
  const parsed = context.window.michiParser(
    "明日 午後3時 セミナー 1時間半",
    new Date("2026-10-18T00:00:00.000Z"),
    "Asia/Tokyo",
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.event.title, "セミナー");
  assert.equal(parsed.durationSpecified, true);
  const weekdayBatch = context.window.michiParser(
    "来週の火曜と水曜と土曜日に17時からバイト",
    new Date("2026-10-21T02:00:00.000Z"),
    "Asia/Tokyo",
  );
  assert.deepEqual(Array.from(weekdayBatch.events.map(event => event.start)), [
    "2026-10-27T08:00:00.000Z",
    "2026-10-28T08:00:00.000Z",
    "2026-10-31T08:00:00.000Z",
  ]);
  const template = context.window.michiParser(
    "来週火曜①",
    new Date("2026-10-21T02:00:00.000Z"),
    "Asia/Tokyo",
    [{ id: "work", shortcut: "①", title: "バイト", time: "17:00", durationMinutes: 60 }],
  );
  assert.equal(template.event.title, "バイト");
  assert.equal(template.event.start, "2026-10-27T08:00:00.000Z");

  const eventModel = context.window.michiEventModel;
  assert.equal(typeof eventModel?.normalizeRecurrence, "function");
  assert.equal(eventModel.normalizeRecurrence(["RRULE:FREQ=WEEKLY"]), "weekly");
  assert.deepEqual(Array.from(eventModel.serializeEvent({ recurrence: "weekly" }).recurrence), ["RRULE:FREQ=WEEKLY"]);
  assert.equal(typeof eventModel.localEventInstant, "function");
  const allDay = new Date(eventModel.localEventInstant("2026-10-20"));
  assert.equal(allDay.getDate(), 20);
  assert.equal(typeof eventModel.mergeCalendarEvents, "function");
  assert.equal(typeof eventModel.allDayOccurrences, "function");
  const clipped = eventModel.allDayOccurrences(
    { id: "holiday", start: eventModel.localEventInstant("2026-10-18"), end: eventModel.localEventInstant("2026-10-22"), allDay: true },
    new Date(2026, 9, 19),
    new Date(2026, 9, 26),
  );
  assert.deepEqual(Array.from(clipped.map(item => item.start.getDate())), [19, 20, 21]);
  const merged = eventModel.mergeCalendarEvents(
    [{ id: "app", title: "old", googleEventId: "owned", cloudStored: true }],
    [
      { id: "daily-1", googleEventId: "daily-1", recurringEventId: "series", start: "2026-10-20T09:00:00Z" },
      { id: "daily-2", googleEventId: "daily-2", recurringEventId: "series", start: "2026-10-21T09:00:00Z" },
      { id: "owned-instance", googleEventId: "owned-1", recurringEventId: "owned" },
    ],
    [{ id: "app", title: "moved", start: "2026-10-22T09:00:00Z", end: "2026-10-22T10:00:00Z" }],
  );
  assert.deepEqual(Array.from(merged.map(event => event.id)), ["app", "daily-1", "daily-2"]);
  assert.equal(merged[0].title, "moved");
  assert.equal(merged[0].cloudStored, true);
});
