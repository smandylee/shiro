// Render candidate expressions offline, so what deformation alone can do gets
// judged by looking at it rather than by argument.
//
// Nothing here is new art. Every expression is the SAME parts, moved:
//   - eyebrows rotate about their outer ends (inner end down = angry, up = sad)
//   - the eyes scale vertically about the eye line (squint / wide)
//   - the irides scale about each pupil's own centre (dilate / contract)
//   - the mouth scales about its own centre
//   - blush is painted on, since face.png already carries a faint one
//
// This is possible at all because See-through rebuilt face.png as a complete,
// blank face: no eyes, no mouth, no brows. Parts can be moved or hidden and
// clean skin shows through instead of a hole.
//
//   node tools/preview-face.mjs [name,name,...]
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAYERS = join(ROOT, "layers");
const manifest = JSON.parse(readFileSync(join(LAYERS, "layers.json"), "utf8"));
const W = manifest.canvas.width;
const H = manifest.canvas.height;

/* ---- measured from the art ---- */
const BROW_PIVOT = { "eyebrow-l": [823, 451], "eyebrow-r": [458, 451] };
const EYE_LINE = 543; // the eyes scale vertically about this
const IRIS_PIVOT = { "irides-l": [759, 544], "irides-r": [525, 544] };
const MOUTH_PIVOT = [642, 693];
const BLUSH = [[511, 605], [773, 604]];
const BLUSH_R = 78;

// Positive browAngle drops the inner ends: angry. Negative lifts them: sad.
const FACES = [
  { name: "neutral" },
  { name: "happy", brow: -2, raise: 3, eye: 0.82, blush: 0.15, mouth: [1.1, 1.15] },
  { name: "sad", brow: -8, raise: -2, eye: 0.9, pupil: 1.05, mouth: [0.8, 0.5] },
  { name: "angry", brow: 10, raise: -4, eye: 1.05, pupil: 0.85, mouth: [1.15, 1.2] },
  { name: "surprised", brow: -4, raise: 10, eye: 1.25, pupil: 1.2, mouth: [0.75, 1.2] },
  { name: "embarrassed", brow: -6, raise: 1, eye: 0.85, pupil: 1.05, blush: 1, mouth: [0.75, 0.65] },
  { name: "thinking", brow: 4, raise: 0, eye: 0.85, mouth: [0.7, 0.45] },
  { name: "love", brow: -3, raise: 3, eye: 0.85, pupil: 1.3, blush: 0.55, mouth: [1.05, 1.1] },
  // Deliberately absurd, to test whether the brows are visible at all.
  { name: "browtest-down", brow: 22, raise: -8 },
  { name: "browtest-up", brow: -22, raise: 12 },
];

/* ---- 2x3 affine helpers: [a,b,c,d,e,f] maps (x,y) -> (ax+cy+e, bx+dy+f) ---- */
const I = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const about = (p, m) => mul(mul([1, 0, 0, 1, p[0], p[1]], m), [1, 0, 0, 1, -p[0], -p[1]]);
const rot = (deg) => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
};
const scale = (sx, sy) => [sx, 0, 0, sy, 0, 0];
const move = (dx, dy) => [1, 0, 0, 1, dx, dy];

function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

const layerCache = new Map();
const load = (f) => {
  if (!layerCache.has(f)) layerCache.set(f, PNG.sync.read(readFileSync(join(LAYERS, f))));
  return layerCache.get(f);
};

/** Blit a layer through an affine transform, sampling the source bilinearly. */
function blit(dst, img, ox, oy, m) {
  const inv = invert(m);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = inv[0] * x + inv[2] * y + inv[4] - ox;
      const sy = inv[1] * x + inv[3] * y + inv[5] - oy;
      if (sx < 0 || sy < 0 || sx >= img.width - 1 || sy >= img.height - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < 4; k++) {
        const wx = k & 1 ? fx : 1 - fx;
        const wy = k & 2 ? fy : 1 - fy;
        const w = wx * wy;
        if (!w) continue;
        const i = ((y0 + (k >> 1)) * img.width + x0 + (k & 1)) * 4;
        const al = img.data[i + 3] / 255;
        r += img.data[i] * al * w;
        g += img.data[i + 1] * al * w;
        b += img.data[i + 2] * al * w;
        a += al * w;
      }
      if (a < 0.004) continue;
      const d = (y * W + x) * 4;
      const inv2 = 1 - a;
      dst.data[d] = r + dst.data[d] * inv2;
      dst.data[d + 1] = g + dst.data[d + 1] * inv2;
      dst.data[d + 2] = b + dst.data[d + 2] * inv2;
      dst.data[d + 3] = Math.min(255, a * 255 + dst.data[d + 3] * inv2);
    }
  }
}

function paintBlush(dst, amount) {
  if (!amount) return;
  for (const [cx, cy] of BLUSH) {
    for (let y = cy - BLUSH_R; y <= cy + BLUSH_R; y++) {
      for (let x = cx - BLUSH_R * 1.15; x <= cx + BLUSH_R * 1.15; x++) {
        const nx = (x - cx) / (BLUSH_R * 1.15);
        const ny = (y - cy) / (BLUSH_R * 0.72);
        const r = Math.hypot(nx, ny);
        if (r >= 1) continue;
        const t = 1 - r;
        const a = amount * 0.42 * t * t * (3 - 2 * t);
        const d = ((y | 0) * W + (x | 0)) * 4;
        if (dst.data[d + 3] < 40) continue; // only on skin
        dst.data[d] = 244 * a + dst.data[d] * (1 - a);
        dst.data[d + 1] = 138 * a + dst.data[d + 1] * (1 - a);
        dst.data[d + 2] = 146 * a + dst.data[d + 2] * (1 - a);
      }
    }
  }
}

function transformFor(id, f) {
  const brow = f.brow ?? 0;
  const raise = f.raise ?? 0;
  const eye = f.eye ?? 1;
  const pupil = f.pupil ?? 1;
  const mouth = f.mouth ?? [1, 1];
  if (BROW_PIVOT[id]) {
    // Mirrored, so "inner end down" means down on both sides.
    const sign = id === "eyebrow-l" ? -1 : 1;
    return mul(move(0, -raise), about(BROW_PIVOT[id], rot(brow * sign)));
  }
  if (id.startsWith("eyewhite") || id.startsWith("eyelash")) {
    return about([W / 2, EYE_LINE], scale(1, eye));
  }
  if (IRIS_PIVOT[id]) {
    // The lids close over the eye, and the pupil dilates in place inside it.
    return mul(about([W / 2, EYE_LINE], scale(1, eye)), about(IRIS_PIVOT[id], scale(pupil, pupil)));
  }
  if (id === "mouth") return about(MOUTH_PIVOT, scale(mouth[0], mouth[1]));
  return I;
}

/* ---- render ---- */

const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
const SHOW = only ? FACES.filter((f) => only.has(f.name)) : FACES;
const CROP = [400, 380, 890, 760];
const [cx1, cy1, cx2, cy2] = CROP;
const cw = cx2 - cx1;
const ch = cy2 - cy1;
const GAP = 6;
const sheet = new PNG({ width: cw * SHOW.length + GAP * (SHOW.length - 1), height: ch });
sheet.data.fill(255);

const FACE_START = manifest.layers.findIndex((l) => l.id === "face");

SHOW.forEach((f, fi) => {
  const frame = new PNG({ width: W, height: H });
  frame.data.fill(0);
  for (let i = FACE_START; i < manifest.layers.length; i++) {
    const l = manifest.layers[i];
    blit(frame, load(l.file), l.x ?? 0, l.y ?? 0, transformFor(l.id, f));
    if (l.id === "face") paintBlush(frame, f.blush ?? 0);
  }
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const s = ((y + cy1) * W + x + cx1) * 4;
      const d = (y * sheet.width + x + fi * (cw + GAP)) * 4;
      const a = frame.data[s + 3] / 255;
      for (let c = 0; c < 3; c++) sheet.data[d + c] = frame.data[s + c] + 255 * (1 - a);
      sheet.data[d + 3] = 255;
    }
  }
  console.log(`  ${f.name}`);
});

writeFileSync(join(LAYERS, "_faces.png"), PNG.sync.write(sheet));
console.log(`-> layers/_faces.png  (${SHOW.map((f) => f.name).join(", ")})`);
