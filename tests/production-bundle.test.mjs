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
  const parserScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(parserScript, "page contains the embedded parser script");

  const context = { window: {} };
  vm.runInNewContext(parserScript, context, { timeout: 1_000 });
  assert.equal(typeof context.window.michiParser, "function");
  const parsed = context.window.michiParser(
    "明日 午後3時 セミナー 1時間半",
    new Date("2026-10-18T00:00:00.000Z"),
    "Asia/Tokyo",
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.event.title, "セミナー");
  assert.equal(parsed.durationSpecified, true);

  const eventModel = context.window.michiEventModel;
  assert.equal(typeof eventModel?.normalizeRecurrence, "function");
  assert.equal(eventModel.normalizeRecurrence(["RRULE:FREQ=WEEKLY"]), "weekly");
  assert.deepEqual(Array.from(eventModel.serializeEvent({ recurrence: "weekly" }).recurrence), ["RRULE:FREQ=WEEKLY"]);
});
