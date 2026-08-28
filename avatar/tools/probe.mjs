// Compare the source image against See-through's own reconstruction and against
// the union of the class layers, to find pixels that belong to the character but
// were never assigned to any part.
import { PNG } from "pngjs";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "seethrough", "out", "shiro_base");
const A = 160;

const load = (dir, f) => PNG.sync.read(readFileSync(join(dir, f)));

const src = load(SRC, "src_img.png");
const recon = load(SRC, "reconstruction.png");
const W = src.width;
const H = src.height;

const CLASSES = readdirSync(SRC).filter(
  (f) =>
    f.endsWith(".png") &&
    !f.endsWith("_depth.png") &&
    !["reconstruction.png", "src_img.png", "src_head.png", "head.png"].includes(f)
);

// Union of every class mask: what the decomposition actually accounts for.
const covered = new Uint8Array(W * H);
for (const f of CLASSES) {
  const png = load(SRC, f);
  for (let p = 0; p < W * H; p++) if (png.data[p * 4 + 3] >= A) covered[p] = 1;
}

let reconOnly = 0;
let srcCharNotCovered = 0;
const residual = new PNG({ width: W, height: H });
residual.data.fill(0);

for (let p = 0; p < W * H; p++) {
  const i = p * 4;
  const reconA = recon.data[i + 3];
  // The source has an opaque background; treat near-white as backdrop.
  const r = src.data[i];
  const g = src.data[i + 1];
  const b = src.data[i + 2];
  const isBackdrop = r > 228 && g > 228 && b > 228;

  if (reconA >= A && !covered[p]) reconOnly++;

  if (!isBackdrop && !covered[p]) {
    srcCharNotCovered++;
    residual.data[i] = r;
    residual.data[i + 1] = g;
    residual.data[i + 2] = b;
    residual.data[i + 3] = 255;
  }
}

console.log(`classes unioned: ${CLASSES.length}`);
console.log(`pixels in reconstruction but in no class: ${reconOnly}`);
console.log(`non-backdrop source pixels in no class:   ${srcCharNotCovered}`);

writeFileSync(join(ROOT, "layers", "_residual.png"), PNG.sync.write(residual));
console.log("wrote layers/_residual.png");

// Spot-check the dark sleeve areas the eye says are missing.
const probe = (x, y) => {
  const i = (y * W + x) * 4;
  return {
    src: [src.data[i], src.data[i + 1], src.data[i + 2]],
    reconAlpha: recon.data[i + 3],
    covered: covered[y * W + x],
  };
};
for (const [x, y] of [
  [250, 1150],
  [300, 1230],
  [1020, 1150],
  [980, 1230],
]) {
  const r = probe(x, y);
  console.log(`  (${x},${y}) src=${r.src.join(",")} reconA=${r.reconAlpha} covered=${r.covered}`);
}
