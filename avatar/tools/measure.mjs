// Where do the parts actually sit? Pivots guessed by eye make the rig twist,
// so read them off the pixels instead.
//
// See-through leaves faint alpha across the whole canvas, so anything reading
// geometry has to threshold well above zero or every part looks 1280x1280.
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAYERS = join(ROOT, "layers");
const A = 160; // "really visible" alpha

const load = (name) => PNG.sync.read(readFileSync(join(LAYERS, name)));

function bounds(png) {
  const { width: w, height: h, data } = png;
  let x1 = w;
  let y1 = h;
  let x2 = -1;
  let y2 = -1;
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] >= A) {
        if (x < x1) x1 = x;
        if (y < y1) y1 = y;
        if (x > x2) x2 = x;
        if (y > y2) y2 = y;
        n++;
        sx += x;
        sy += y;
      }
    }
  }
  return { box: [x1, y1, x2, y2], n, centroid: [Math.round(sx / n), Math.round(sy / n)] };
}

function colSpan(png, col) {
  const { width: w, height: h, data } = png;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    if (data[(y * w + col) * 4 + 3] >= A) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  return [top, bottom];
}

function rowSpan(png, row) {
  const { width: w, data } = png;
  let left = -1;
  let right = -1;
  for (let x = 0; x < w; x++) {
    if (data[(row * w + x) * 4 + 3] >= A) {
      if (left < 0) left = x;
      right = x;
    }
  }
  return [left, right];
}

console.log(`=== bounds at alpha >= ${A} ===`);
const files = [
  "tail-tip.png",
  "tail-base.png",
  "neck.png",
  "face.png",
  "mouth.png",
  "nose.png",
  "topwear.png",
  "headwear.png",
  "eyewhite-r.png",
  "eyewhite-l.png",
  "ears-r.png",
  "ears-l.png",
];
for (const f of files) {
  const r = bounds(load(f));
  console.log(
    `  ${f.padEnd(16)} box=${String(r.box.join(",")).padEnd(20)} centroid=${r.centroid.join(",")}  px=${r.n}`
  );
}

console.log("\n=== tail-tip: where it runs off toward the body ===");
const tip = load("tail-tip.png");
for (const c of [560, 580, 600, 620]) console.log(`  col ${c}: ${colSpan(tip, c).join(" .. ")}`);

console.log("\n=== tail-base: where it exits the bottom of the frame ===");
const base = load("tail-base.png");
for (const r of [1279, 1240, 1200, 1150]) console.log(`  row ${r}: ${rowSpan(base, r).join(" .. ")}`);

console.log("\n=== neck: top edge is the head pivot ===");
const neck = load("neck.png");
const nb = bounds(neck).box;
console.log(`  box ${nb.join(", ")}`);
for (const r of [nb[1], nb[1] + 20, nb[3]]) console.log(`  row ${r}: ${rowSpan(neck, r).join(" .. ")}`);
