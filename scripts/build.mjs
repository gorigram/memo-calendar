import { build } from "esbuild";
import { mkdir, readFile, readdir, stat, writeFile, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "worker/index.js");
const manifestSource = resolve(root, ".openai/hosting.json");
const output = resolve(root, "dist/server/index.js");
const manifestOutput = resolve(root, "dist/.openai/hosting.json");
const migrationsSource = resolve(root, "drizzle");
const migrationsOutput = resolve(root, "dist/.openai/drizzle");

async function copyTree(source, destination) {
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const from = resolve(source, entry.name);
    const to = resolve(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error(`Refusing to package non-regular migration entry: ${from}`);
  }
}

const manifest = await readFile(manifestSource, "utf8");
JSON.parse(manifest);
await mkdir(dirname(output), { recursive: true });
await mkdir(dirname(manifestOutput), { recursive: true });
await build({
  entryPoints: [entry],
  outfile: output,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  charset: "utf8",
  legalComments: "none",
  logLevel: "info",
});
await writeFile(manifestOutput, manifest);
try {
  if ((await stat(migrationsSource)).isDirectory()) await copyTree(migrationsSource, migrationsOutput);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
console.log(`Built ${output}`);
