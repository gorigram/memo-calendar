import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const bundlePath = resolve(projectRoot, "dist/server/index.js");
const moduleUrl = pathToFileURL(bundlePath).href;
let worker;
let loadedBundleVersion;

async function loadWorkerIfChanged() {
  const bundle = await stat(bundlePath);
  const version = `${bundle.mtimeMs}:${bundle.size}`;
  if (version === loadedBundleVersion) return worker;

  const nextWorker = await import(`${moduleUrl}?mtime=${encodeURIComponent(version)}`);
  if (typeof nextWorker.default?.fetch !== "function") {
    throw new TypeError("dist/server/index.js must export default.fetch");
  }

  worker = nextWorker;
  loadedBundleVersion = version;
  if (loadedBundleVersion !== undefined) {
    console.log(`Loaded worker bundle (${version})`);
  }
  return worker;
}

await loadWorkerIfChanged();

const server = createServer(async (incoming, outgoing) => {
  try {
    const activeWorker = await loadWorkerIfChanged();
    const origin = `http://${incoming.headers.host || `${host}:${port}`}`;
    const method = incoming.method || "GET";
    const init = { method, headers: incoming.headers };
    if (method !== "GET" && method !== "HEAD") init.body = incoming;
    if (init.body) init.duplex = "half";
    const request = new Request(new URL(incoming.url || "/", origin), init);
    const response = await activeWorker.default.fetch(request, {}, { waitUntil() {} });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (method === "HEAD" || !response.body) {
      outgoing.end();
      return;
    }
    for await (const chunk of response.body) outgoing.write(chunk);
    outgoing.end();
  } catch (error) {
    console.error("Local Worker request failed:", error);
    if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("Local Worker error");
  }
});

server.listen(port, host, () => console.log(`Local preview: http://${host}:${port} (pid ${process.pid})`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
