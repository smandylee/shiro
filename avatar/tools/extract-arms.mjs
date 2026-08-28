// See-through V3 has no class for bare skin, so this character's arms — and the
// dark sleeves around them — were dropped entirely; they are missing from its
// own reconstruction too. The pixels are still in the source, so recover them.
//
// Method: flood the backdrop inward from the border, using the union of the
// class masks as a wall. Everything the flood can't reach and no class claims
// is a real part of the character that the decomposition lost.
import { PNG } from "pngjs";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "seethrough", "out", "shiro_base");
const OUT = join(ROOT, "layers");
const ALPHA = 160;
const TOL = 14; // per-channel tolerance while growing the backdrop
// The two arms come out around 30k px each; everything smaller is a stray hair
// sliver the classifier also missed, and those are better dropped than pasted
// back at the arms' depth.
const MIN_BLOB = 10000;

const load = (f) => PNG.sync.read(readFileSync(join(SRC, f)));
const src = load("src_img.png");
const W = src.width;
const H = src.height;
const at = (x, y) => (y * W + x) * 4;

const SKIP = new Set(["reconstruction.png", "src_img.png", "src_head.png", "head.png"]);
const covered = new Uint8Array(W * H);
for (const f of readdirSync(SRC)) {
  if (!f.endsWith(".png") || f.endsWith("_depth.png") || SKIP.has(f)) continue;
  const png = load(f);
  for (let p = 0; p < W * H; p++) if (png.data[p * 4 + 3] >= ALPHA) covered[p] = 1;
}

/* ---- flood the backdrop in from the frame edge ---- */

const backdrop = new Uint8Array(W * H);
const queue = [];

// She runs off the bottom of the frame, so the border is not all backdrop —
// seeding it blindly floods straight through her arm and erases it. Only seed
// border pixels that actually look like the pale backdrop.
const BACKDROP_MIN = 200;

function seed(x, y) {
  const p = y * W + x;
  if (covered[p] || backdrop[p]) return;
  const i = p * 4;
  if (src.data[i] < BACKDROP_MIN || src.data[i + 1] < BACKDROP_MIN || src.data[i + 2] < BACKDROP_MIN) {
    return;
  }
  backdrop[p] = 1;
  queue.push(p);
}
for (let x = 0; x < W; x++) {
  seed(x, 0);
  seed(x, H - 1);
}
for (let y = 0; y < H; y++) {
  seed(0, y);
  seed(W - 1, y);
}

const near = (i, j) =>
  Math.abs(src.data[i] - src.data[j]) <= TOL &&
  Math.abs(src.data[i + 1] - src.data[j + 1]) <= TOL &&
  Math.abs(src.data[i + 2] - src.data[j + 2]) <= TOL;

for (let head = 0; head < queue.length; head++) {
  const p = queue[head];
  const x = p % W;
  const y = (p / W) | 0;
  const i = p * 4;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const q = ny * W + nx;
    if (backdrop[q] || covered[q]) continue;
    // Compare with the pixel we came from, so a smooth gradient still floods.
    if (!near(i, at(nx, ny))) continue;
    backdrop[q] = 1;
    queue.push(q);
  }
}

/* ---- what's left over is lost character ---- */

const leftover = new Uint8Array(W * H);
let count = 0;
for (let p = 0; p < W * H; p++) {
  if (!covered[p] && !backdrop[p]) {
    leftover[p] = 1;
    count++;
  }
}
console.log(`backdrop: ${backdrop.reduce((a, b) => a + b, 0)}  leftover: ${count}`);

/* ---- drop speckle, keep real blobs ---- */

const keep = new Uint8Array(W * H);
const seen = new Uint8Array(W * H);
const blobs = [];
for (let start = 0; start < W * H; start++) {
  if (!leftover[start] || seen[start]) continue;
  const stack = [start];
  const cells = [];
  seen[start] = 1;
  while (stack.length) {
    const p = stack.pop();
    cells.push(p);
    const x = p % W;
    const y = (p / W) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const q = ny * W + nx;
      if (leftover[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  if (cells.length >= MIN_BLOB) {
    blobs.push(cells.length);
    for (const p of cells) keep[p] = 1;
  }
}
blobs.sort((a, b) => b - a);
console.log(`blobs kept (>= ${MIN_BLOB}px): ${blobs.length} -> ${blobs.slice(0, 8).join(", ")}`);

/* ---- write it out ---- */

const out = new PNG({ width: W, height: H });
out.data.fill(0);
let written = 0;
let x1 = W;
let y1 = H;
let x2 = -1;
let y2 = -1;
for (let p = 0; p < W * H; p++) {
  if (!keep[p]) continue;
  const i = p * 4;
  out.data[i] = src.data[i];
  out.data[i + 1] = src.data[i + 1];
  out.data[i + 2] = src.data[i + 2];
  out.data[i + 3] = 255;
  written++;
  const x = p % W;
  const y = (p / W) | 0;
  if (x < x1) x1 = x;
  if (y < y1) y1 = y;
  if (x > x2) x2 = x;
  if (y > y2) y2 = y;
}
writeFileSync(join(OUT, "arms.png"), PNG.sync.write(out));
console.log(`arms.png: ${written} px, bounds ${x1},${y1},${x2},${y2}`);
