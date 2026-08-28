// Find the tail's centerline so it can be bent like a real tail instead of
// swung like a stick.
//
// Two things make this harder than "skeletonise the mask":
//   1. See-through completes every part as if nothing covered it, so the tail
//      mask includes a large invented slab lying behind her blouse. Averaged
//      into a centroid it drags the spine straight through her chest.
//   2. The tail is drawn behind everything except the back hair, so "visible"
//      is exactly "not covered by any nearer layer".
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "layers", "layers.json"), "utf8"));
const W = manifest.canvas.width;
const H = manifest.canvas.height;
const load = (f) => PNG.sync.read(readFileSync(join(ROOT, "layers", f)));

const TAIL_IDS = new Set(["tail-base", "tail-tip"]);
const tailDepth = manifest.layers.find((l) => l.id === "tail-base").depth;

const tail = new Uint8Array(W * H);
for (const l of manifest.layers) {
  if (!TAIL_IDS.has(l.id)) continue;
  const png = load(l.file);
  for (let p = 0; p < W * H; p++) if (png.data[p * 4 + 3] >= 32) tail[p] = 1;
}

const occluder = new Uint8Array(W * H);
for (const l of manifest.layers) {
  if (TAIL_IDS.has(l.id) || l.depth >= tailDepth) continue;
  const png = load(l.file);
  for (let p = 0; p < W * H; p++) if (png.data[p * 4 + 3] >= 128) occluder[p] = 1;
}

const visible = new Uint8Array(W * H);
let nTail = 0;
let nVis = 0;
for (let p = 0; p < W * H; p++) {
  if (!tail[p]) continue;
  nTail++;
  if (!occluder[p]) {
    visible[p] = 1;
    nVis++;
  }
}
console.log(`tail mask ${nTail}px -> visible ${nVis}px (${((nVis / nTail) * 100).toFixed(0)}%)`);

/* ---- connected components of the visible tail ---- */

const label = new Int32Array(W * H).fill(-1);
const comps = [];
for (let start = 0; start < W * H; start++) {
  if (!visible[start] || label[start] >= 0) continue;
  const id = comps.length;
  const cells = [];
  const stack = [start];
  label[start] = id;
  while (stack.length) {
    const p = stack.pop();
    cells.push(p);
    const x = p % W;
    const y = (p / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const q = ny * W + nx;
      if (visible[q] && label[q] < 0) {
        label[q] = id;
        stack.push(q);
      }
    }
  }
  comps.push(cells);
}
comps.sort((a, b) => b.length - a.length);
console.log(`components: ${comps.slice(0, 6).map((c) => c.length).join(", ")}`);
for (const c of comps.slice(0, 4)) {
  let x1 = W, y1 = H, x2 = -1, y2 = -1;
  for (const p of c) {
    const x = p % W;
    const y = (p / W) | 0;
    if (x < x1) x1 = x;
    if (y < y1) y1 = y;
    if (x > x2) x2 = x;
    if (y > y2) y2 = y;
  }
  console.log(`  ${String(c.length).padStart(7)}px  bbox ${x1},${y1} .. ${x2},${y2}`);
}

/* ---- debug image ---- */

const src = PNG.sync.read(readFileSync(join(ROOT, "seethrough", "out", "shiro_base", "src_img.png")));
const out = new PNG({ width: W, height: H });
const COLORS = [[228, 60, 60], [40, 110, 235], [235, 170, 40], [60, 190, 110]];
for (let p = 0; p < W * H; p++) {
  const i = p * 4;
  const a = src.data[i + 3] / 255;
  const g = (v) => v * a + 255 * (1 - a);
  let r = g(src.data[i]) * 0.35 + 166;
  let gg = g(src.data[i + 1]) * 0.35 + 166;
  let b = g(src.data[i + 2]) * 0.35 + 166;
  const id = label[p];
  if (id >= 0 && id < 4) [r, gg, b] = COLORS[id];
  else if (tail[p]) { r = 210; gg = 205; b = 200; }
  out.data[i] = r; out.data[i + 1] = gg; out.data[i + 2] = b; out.data[i + 3] = 255;
}
writeFileSync(join(ROOT, "layers", "_tailvis.png"), PNG.sync.write(out));
console.log("layers/_tailvis.png");
