import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = resolve(projectRoot, "dist/server/index.js");
const manifestPath = resolve(projectRoot, "dist/.openai/hosting.json");

test("build emits a valid ESM worker and copies the hosting manifest", async () => {
  const [source, manifest, originalManifest] = await Promise.all([
    readFile(workerPath, "utf8"),
    readFile(manifestPath, "utf8"),
    readFile(resolve(projectRoot, ".openai/hosting.json"), "utf8"),
  ]);
  assert.deepEqual(JSON.parse(manifest), JSON.parse(originalManifest));
  const workerModule = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.equal(typeof workerModule.default?.fetch, "function");

  const env = {};
  const ctx = { waitUntil() {} };
  const page = await workerModule.default.fetch(new Request("https://memo-calendar.local/"), env, ctx);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") || "", /text\/html/);
  assert.match(await page.text(), /<!doctype html>/i);

  const status = await workerModule.default.fetch(new Request("https://memo-calendar.local/api/status"), env, ctx);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    ok: true,
    mode: "local",
    storage: "unavailable",
    authenticated: false,
    accountKey: null,
    google: { configured: false, connected: false },
    ai: "rules",
  });

  for (const [path, size] of [["/apple-touch-icon.png", 180], ["/icon-192.png", 192], ["/icon-512.png", 512]]) {
    const icon = await workerModule.default.fetch(new Request(`https://memo-calendar.local${path}`), env, ctx);
    assert.equal(icon.status, 200, `${path} is served`);
    assert.match(icon.headers.get("content-type") || "", /^image\/png/);
    assert.match(icon.headers.get("cache-control") || "", /max-age=86400/);
    const png = Buffer.from(await icon.arrayBuffer());
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }

  const packagedMigrations = await readdir(resolve(projectRoot, "dist/.openai/drizzle"));
  assert.ok(packagedMigrations.some((name) => name.endsWith(".sql")), "D1 SQL migrations must be in the hosting artifact");
  assert.ok(packagedMigrations.includes("meta"), "Drizzle migration metadata must be in the hosting artifact");
});
