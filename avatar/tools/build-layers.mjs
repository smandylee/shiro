// Turns See-through's per-part PNGs into the layer set the avatar animates,
// and writes the manifest that describes draw order, groups, and pivots.
//
//   node tools/build-layers.mjs
//
// Re-runnable: it only reads from seethrough/out and writes to layers/.

import { PNG } from "pngjs";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "seethrough", "out", "shiro_base");
const OUT = join(ROOT, "layers");
const META = JSON.parse(readFileSync(join(ROOT, "seethrough", "out", "shiro_base.psd.json"), "utf8"));
const SIZE = META.frame_size[0];

mkdirSync(OUT, { recursive: true });

function read(name) {
  return PNG.sync.read(readFileSync(join(SRC, name)));
}

/** Copy only the pixels inside [x1,y1,x2,y2]; canvas size is preserved. */
function crop(src, out, box) {
  const png = read(src);
  const dst = new PNG({ width: SIZE, height: SIZE });
  dst.data.fill(0);
  const [x1, y1, x2, y2] = box;
  for (let y = Math.max(0, y1); y < Math.min(SIZE, y2); y++) {
    for (let x = Math.max(0, x1); x < Math.min(SIZE, x2); x++) {
      const i = (y * SIZE + x) * 4;
      dst.data[i] = png.data[i];
      dst.data[i + 1] = png.data[i + 1];
      dst.data[i + 2] = png.data[i + 2];
      dst.data[i + 3] = png.data[i + 3];
    }
  }
  writeFileSync(join(OUT, out), PNG.sync.write(dst));
  return countOpaque(dst);
}

function copyWhole(src, out) {
  const png = read(src);
  writeFileSync(join(OUT, out), PNG.sync.write(png));
  return countOpaque(png);
}

function countOpaque(png) {
  let n = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > 8) n++;
  return n;
}

/** Tight bounding box of the visible pixels — used to place pivots honestly. */
function boundsOf(name) {
  const png = read(name);
  let x1 = SIZE;
  let y1 = SIZE;
  let x2 = 0;
  let y2 = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (png.data[(y * SIZE + x) * 4 + 3] > 8) {
        if (x < x1) x1 = x;
        if (y < y1) y1 = y;
        if (x > x2) x2 = x;
        if (y > y2) y2 = y;
      }
    }
  }
  return [x1, y1, x2, y2];
}

const written = [];
const log = (file, note, px) => {
  written.push(file);
  console.log(`  ${file.padEnd(20)} ${String(px).padStart(8)} px  ${note}`);
};

console.log("=== left/right splits ===");
const SIDED = ["ears", "eyewhite", "irides", "eyelash", "eyebrow"];
for (const name of SIDED) {
  for (const side of ["r", "l"]) {
    const part = META.parts[`${name}-${side}`];
    if (!part) {
      console.log(`  ${name}-${side}: no bbox, skipped`);
      continue;
    }
    const file = `${name}-${side}.png`;
    log(file, `bbox ${part.xyxy.join(",")}`, crop(`${name}.png`, file, part.xyxy));
  }
}

console.log("=== tail split ===");
// The tail passes behind the body, so its tip and its base need separate
// pivots — swinging both from one root would fling the tip across the screen.
const TAIL_CUT = 630;
log("tail-tip.png", `x < ${TAIL_CUT}`, crop("tail.png", "tail-tip.png", [0, 0, TAIL_CUT, SIZE]));
log("tail-base.png", `x >= ${TAIL_CUT}`, crop("tail.png", "tail-base.png", [TAIL_CUT, 0, SIZE, SIZE]));

console.log("=== whole parts ===");
const WHOLE = {
  "back hair.png": "back_hair.png",
  "front hair.png": "front_hair.png",
  "headwear.png": "headwear.png",
  "earwear.png": "earwear.png",
  "face.png": "face.png",
  "nose.png": "nose.png",
  "mouth.png": "mouth.png",
  "neck.png": "neck.png",
  "neckwear.png": "neckwear.png",
  "topwear.png": "topwear.png",
};
// Recovered separately: V3 has no skin class, so her arms and the dark sleeves
// around them exist in no part file. tools/extract-arms.mjs digs them back out.
if (existsSync(join(OUT, "arms.png"))) {
  const png = PNG.sync.read(readFileSync(join(OUT, "arms.png")));
  let px = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > 8) px++;
  log("arms.png", "recovered residual", px);
} else {
  console.log("  arms.png: not built yet - run tools/extract-arms.mjs first");
}

for (const [src, out] of Object.entries(WHOLE)) {
  if (!existsSync(join(SRC, src))) {
    console.log(`  ${src}: missing, skipped`);
    continue;
  }
  // See-through emits a file per class even when the character has no such
  // part; a handful of stray pixels means "not present", not "tiny layer".
  const px = copyWhole(src, out);
  if (px < 200) {
    console.log(`  ${out.padEnd(20)} ${String(px).padStart(8)} px  (empty, dropped)`);
    continue;
  }
  log(out, "whole", px);
}

/* ---------- overlap cleanup ---------- */

const VISIBLE = 160; // See-through leaves faint alpha everywhere; ignore it

// See-through completes every part as if nothing covered it, so the blouse
// carries a filled-in collar opening exactly where her neck is. Stacked either
// way round one erases the other — fabric over the neck, or neck over the lace —
// and a single depth per layer can't help, because both genuinely own those
// pixels at different points.
//
// Per-pixel depth can. See-through ships a depth map per part, where a lower
// value is nearer the viewer, so at every overlapping pixel it says outright
// which part is the surface on show. Only the front layer is cut, leaving the
// one behind its hidden margin to move into.
//
// (Matching colours against the source does not work here: these layers are
// redrawn by a diffusion model rather than cut out, so even visible pixels
// differ a little, and shadowed skin sits close to the grey filler.)
const SRC_NAME = {
  back_hair: "back hair",
  front_hair: "front hair",
  "tail-tip": "tail",
  "tail-base": "tail",
};
const depthOf_ = (id) => `${SRC_NAME[id] ?? id.replace(/-[rl]$/, "")}_depth.png`;

function reclaim(frontId, backId, { margin = 3 } = {}) {
  const front = PNG.sync.read(readFileSync(join(OUT, `${frontId}.png`)));
  const back = PNG.sync.read(readFileSync(join(OUT, `${backId}.png`)));
  const frontD = PNG.sync.read(readFileSync(join(SRC, depthOf_(frontId))));
  const backD = PNG.sync.read(readFileSync(join(SRC, depthOf_(backId))));

  let cut = 0;
  let overlap = 0;
  for (let p = 0; p < SIZE * SIZE; p++) {
    const i = p * 4;
    if (front.data[i + 3] < VISIBLE || back.data[i + 3] < VISIBLE) continue;
    overlap++;
    if (backD.data[i] + margin < frontD.data[i]) {
      front.data[i + 3] = 0;
      cut++;
    }
  }
  writeFileSync(join(OUT, `${frontId}.png`), PNG.sync.write(front));
  console.log(`  ${frontId} yielded ${cut}/${overlap} overlapping px to ${backId}`);
}

console.log("=== overlap cleanup ===");
reclaim("topwear", "neck");

/* ---------- pivots ---------- */

// A pivot belongs to a GROUP, not to a layer: the whole head has to swing about
// one point at the base of the neck, or the eyes and nose shear off the face.
// Every number below is read off the pixels — guessed pivots are what made the
// first version twist.


function measure(file) {
  const png = PNG.sync.read(readFileSync(join(OUT, file)));
  let x1 = SIZE;
  let y1 = SIZE;
  let x2 = -1;
  let y2 = -1;
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (png.data[(y * SIZE + x) * 4 + 3] >= VISIBLE) {
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
  const rowCentre = (row) => {
    let l = -1;
    let r = -1;
    for (let x = 0; x < SIZE; x++) {
      if (png.data[(row * SIZE + x) * 4 + 3] >= VISIBLE) {
        if (l < 0) l = x;
        r = x;
      }
    }
    return l < 0 ? null : Math.round((l + r) / 2);
  };
  const colCentre = (col) => {
    let t = -1;
    let b = -1;
    for (let y = 0; y < SIZE; y++) {
      if (png.data[(y * SIZE + col) * 4 + 3] >= VISIBLE) {
        if (t < 0) t = y;
        b = y;
      }
    }
    return t < 0 ? null : Math.round((t + b) / 2);
  };
  return {
    box: [x1, y1, x2, y2],
    centroid: [Math.round(sx / n), Math.round(sy / n)],
    rowCentre,
    colCentre,
  };
}

console.log("=== pivots (measured) ===");
const mNeck = measure("neck.png");
const mTip = measure("tail-tip.png");
const mBase = measure("tail-base.png");
const mEarR = measure("ears-r.png");
const mEarL = measure("ears-l.png");
const mEyeR = measure("eyewhite-r.png");
const mEyeL = measure("eyewhite-l.png");
const mMouth = measure("mouth.png");

// The tip vanishes behind her shoulder a little before the cut line; hinge it
// where it actually stops rather than at the cut.
const tipEdge = mTip.box[2];
const tipHinge = [tipEdge, mTip.colCentre(tipEdge) ?? mTip.centroid[1]];

// The base runs off the bottom of the frame — its real root is just below.
const baseExit = [mBase.rowCentre(SIZE - 1) ?? mBase.centroid[0], SIZE + 20];

const neckPivot = [mNeck.rowCentre(mNeck.box[3]) ?? 640, mNeck.box[3]];
const eyePivot = [
  Math.round((mEyeR.centroid[0] + mEyeL.centroid[0]) / 2),
  mEyeR.centroid[1],
];

const groups = {
  body: { pivot: [Math.round(SIZE / 2), SIZE] },
  // Her hair hangs off her head, not her hips: it hinges at the neck like the
  // rest of the head, and only trails behind in time.
  hair_back: { pivot: neckPivot },
  // Base of the neck: where a real head hinges.
  head: { pivot: neckPivot },
  hair_front: { pivot: neckPivot },
  eyes: { pivot: eyePivot },
  irides: { pivot: eyePivot },
  mouth: { pivot: mMouth.centroid },
  // Ear base = bottom-centre of the ear, where it meets the skull.
  ear_l: { pivot: [mEarR.rowCentre(mEarR.box[3]) ?? mEarR.centroid[0], mEarR.box[3]] },
  ear_r: { pivot: [mEarL.rowCentre(mEarL.box[3]) ?? mEarL.centroid[0], mEarL.box[3]] },
  tail: { pivot: baseExit },
  tail_tip: { pivot: tipHinge },
};

for (const [k, v] of Object.entries(groups)) {
  console.log(`  ${k.padEnd(12)} ${v.pivot.join(", ")}`);
}

/* ---------- manifest ---------- */

// depth_median from See-through: smaller = nearer the viewer, so drawing in
// descending order puts the far side down first.
const GROUPS = {
  back_hair: "hair_back",
  "tail-tip": "tail_tip",
  "tail-base": "tail",
  neck: "body",
  topwear: "body",
  neckwear: "body",
  arms: "body",
  face: "head",
  nose: "head",
  mouth: "mouth",
  "ears-r": "ear_l",
  "ears-l": "ear_r",
  earwear: "head",
  headwear: "head",
  "eyebrow-r": "head",
  "eyebrow-l": "head",
  "eyewhite-r": "eyes",
  "eyewhite-l": "eyes",
  // Only the irises track gaze. Sliding the whole eye — white, lashes and all —
  // is what made her look wrong when she glanced sideways.
  "irides-r": "irides",
  "irides-l": "irides",
  "eyelash-r": "eyes",
  "eyelash-l": "eyes",
  front_hair: "hair_front",
};

const DEPTH_KEY = {
  back_hair: "back hair",
  front_hair: "front hair",
  "tail-tip": "tail",
  "tail-base": "tail",
  // Sits just behind the blouse, whose puffed sleeves overlap the arm tops.
  arms: null,
};

const DEPTH_OVERRIDE = { arms: 0.75 };

function depthOf(id) {
  if (id in DEPTH_OVERRIDE) return DEPTH_OVERRIDE[id];
  const key = DEPTH_KEY[id] ?? id;
  const part = META.parts[key];
  if (part) return part.depth_median;
  const base = key.replace(/-[rl]$/, "");
  return META.parts[base]?.depth_median ?? 0.5;
}

const layers = written
  .map((file) => {
    const id = file.replace(/\.png$/, "");
    return { file, id, group: GROUPS[id] ?? "body", depth: depthOf(id) };
  })
  .sort((a, b) => b.depth - a.depth);

writeFileSync(
  join(OUT, "layers.json"),
  JSON.stringify({ canvas: { width: SIZE, height: SIZE }, groups, layers }, null, 2)
);

console.log("\n=== draw order (back to front) ===");
for (const l of layers) {
  console.log(`  ${l.depth.toFixed(3)}  ${l.id.padEnd(14)} ${l.group}`);
}
console.log(`\n${layers.length} layers -> layers/layers.json`);
