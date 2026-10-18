import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(projectRoot, "../..");
const outputDir = resolve(workspaceRoot, "outputs/icons");
const modulePath = resolve(projectRoot, "worker/icons.js");
const SCALE = 3;

const rgba = (hex, alpha = 255) => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
  alpha,
];
const blend = (a, b, t) => a.map((channel, i) => Math.round(channel + (b[i] - channel) * t));

function renderIcon(size) {
  const px = size * SCALE;
  const pixels = new Uint8Array(px * px * 4);
  const put = (x, y, color) => {
    if (x < 0 || y < 0 || x >= px || y >= px) return;
    const i = (y * px + x) * 4;
    const a = color[3] / 255;
    pixels[i] = Math.round(color[0] * a + pixels[i] * (1 - a));
    pixels[i + 1] = Math.round(color[1] * a + pixels[i + 1] * (1 - a));
    pixels[i + 2] = Math.round(color[2] * a + pixels[i + 2] * (1 - a));
    pixels[i + 3] = Math.round(255 * a + pixels[i + 3] * (1 - a));
  };
  const roundRect = (x, y, left, top, right, bottom, radius, color) => {
    const dx = Math.max(left + radius - x, 0, x - right + radius);
    const dy = Math.max(top + radius - y, 0, y - bottom + radius);
    return dx * dx + dy * dy <= radius * radius;
  };
  const paintRoundRect = (left, top, right, bottom, radius, color) => {
    const x0 = Math.floor(left * px), x1 = Math.ceil(right * px);
    const y0 = Math.floor(top * px), y1 = Math.ceil(bottom * px);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (roundRect(x / px, y / px, left, top, right, bottom, radius, color)) put(x, y, color);
    }
  };
  const line = (x1, y1, x2, y2, width, color) => {
    const half = width / 2;
    const minX = Math.floor((Math.min(x1, x2) - half) * px);
    const maxX = Math.ceil((Math.max(x1, x2) + half) * px);
    const minY = Math.floor((Math.min(y1, y2) - half) * px);
    const maxY = Math.ceil((Math.max(y1, y2) + half) * px);
    const vx = x2 - x1, vy = y2 - y1, length2 = vx * vx + vy * vy;
    for (let y = minY; y < maxY; y++) for (let x = minX; x < maxX; x++) {
      const nx = (x + 0.5) / px, ny = (y + 0.5) / px;
      const t = Math.max(0, Math.min(1, ((nx - x1) * vx + (ny - y1) * vy) / length2));
      const dx = nx - (x1 + t * vx), dy = ny - (y1 + t * vy);
      if (dx * dx + dy * dy <= half * half) put(x, y, color);
    }
  };
  const polygon = (points, color) => {
    const minX = Math.floor(Math.min(...points.map((p) => p[0])) * px);
    const maxX = Math.ceil(Math.max(...points.map((p) => p[0])) * px);
    const minY = Math.floor(Math.min(...points.map((p) => p[1])) * px);
    const maxY = Math.ceil(Math.max(...points.map((p) => p[1])) * px);
    for (let y = minY; y < maxY; y++) for (let x = minX; x < maxX; x++) {
      const nx = (x + 0.5) / px, ny = (y + 0.5) / px;
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i], [xj, yj] = points[j];
        if ((yi > ny) !== (yj > ny) && nx < ((xj - xi) * (ny - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) put(x, y, color);
    }
  };

  const top = rgba("#a6a1f0"), bottom = rgba("#777fda");
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    put(x, y, blend(top, bottom, Math.min(1, (x / px * 0.38 + y / px * 0.62))));
  }

  // Rounded glass calendar tile, matching the app's lavender identity.
  paintRoundRect(0.19, 0.205, 0.81, 0.795, 0.15, rgba("#ffffff", 245));
  line(0.385, 0.17, 0.385, 0.325, 0.043, rgba("#8b86db"));
  line(0.615, 0.17, 0.615, 0.325, 0.043, rgba("#8b86db"));
  line(0.235, 0.405, 0.765, 0.405, 0.035, rgba("#aaa6e7"));

  const cx = 0.5, cy = 0.58, outer = 0.128, inner = 0.053;
  const sparkle = [];
  for (let i = 0; i < 8; i++) {
    const angle = -Math.PI / 2 + i * Math.PI / 4;
    const radius = i % 2 === 0 ? outer : inner;
    sparkle.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  polygon(sparkle, rgba("#8883e2"));

  // Downsample a small supersampled vector drawing for smooth edges.
  const result = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const total = [0, 0, 0, 0];
    for (let sy = 0; sy < SCALE; sy++) for (let sx = 0; sx < SCALE; sx++) {
      const i = ((y * SCALE + sy) * px + x * SCALE + sx) * 4;
      for (let c = 0; c < 4; c++) total[c] += pixels[i + c];
    }
    const o = (y * size + x) * 4;
    for (let c = 0; c < 4; c++) result[o + c] = Math.round(total[c] / (SCALE * SCALE));
  }
  return result;
}

let crcTable;
function crc32(buffer) {
  crcTable ||= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const payload = Buffer.concat([name, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  payload.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(payload), 8 + data.length);
  return chunk;
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * size * 4, size * 4).copy(raw, row + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

await mkdir(outputDir, { recursive: true });
const files = [
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
];
const base64Entries = [];
for (const [filename, size] of files) {
  const png = encodePng(size, renderIcon(size));
  await writeFile(resolve(outputDir, filename), png);
  base64Entries.push(`  ${JSON.stringify(filename)}: ${JSON.stringify(png.toString("base64"))}`);
  console.log(`${filename}: ${size}×${size}, ${png.length.toLocaleString()} bytes`);
}

const moduleSource = `// Generated by scripts/generate-icons.mjs. Edit that script to change the icon.\nexport const iconPngBase64 = Object.freeze({\n${base64Entries.join(",\n")}\n});\n\nexport const iconPngBytes = (filename) => {\n  const encoded = iconPngBase64[filename];\n  if (!encoded) return null;\n  return Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));\n};\n`;
await writeFile(modulePath, moduleSource);
console.log(`Embedded PNG data in ${modulePath}`);
