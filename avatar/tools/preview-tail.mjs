// Rasterise the tail warp offline so the bend can be judged without launching
// the app. Same rig and same maths as renderer/tail.js; only the rasteriser
// differs (inverse-map every destination pixel instead of leaning on canvas).
//
//   node tools/preview-tail.mjs [amp] [frames] [bias]
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareTail, poseTail, tailBend } from "../renderer/tail.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAYERS = join(ROOT, "layers");

const AMP = Number(process.argv[2] ?? 16);
const FRAMES = Number(process.argv[3] ?? 5);
const BIAS = Number(process.argv[4] ?? 0);
const SHRINK = 2;

const rig = JSON.parse(readFileSync(join(LAYERS, "tail-rig.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(LAYERS, "layers.json"), "utf8"));
const W = manifest.canvas.width;
const H = manifest.canvas.height;

const wave = (ph) => Math.sin(ph) * 0.78 + Math.sin(ph * 0.37 + 1.3) * 0.3;

// Everything that isn't the tail, flattened once — context for judging the bend.
const backdrop = new PNG({ width: W, height: H });
backdrop.data.fill(255);
for (const l of manifest.layers) {
  if (l.warp === "tail") continue;
  const png = PNG.sync.read(readFileSync(join(LAYERS, l.file)));
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    const a = png.data[i + 3] / 255;
    if (!a) continue;
    for (let c = 0; c < 3; c++) {
      backdrop.data[i + c] = png.data[i + c] * a + backdrop.data[i + c] * (1 - a);
    }
  }
}

const tails = rig.tails.map((t) => ({
  rig: prepareTail(t),
  img: PNG.sync.read(readFileSync(join(LAYERS, t.file))),
}));

function ribsFor(pts, half) {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * half[i];
    const ny = (dx / len) * half[i];
    return [[p[0] - nx, p[1] - ny], [p[0] + nx, p[1] + ny]];
  });
}

/** Draw one source triangle onto its deformed counterpart, inverse-mapped. */
function triangle(dst, img, ox, oy, s, d) {
  const minX = Math.max(0, Math.floor(Math.min(d[0][0], d[1][0], d[2][0])));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(d[0][0], d[1][0], d[2][0])));
  const minY = Math.max(0, Math.floor(Math.min(d[0][1], d[1][1], d[2][1])));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(d[0][1], d[1][1], d[2][1])));
  const [[u0, v0], [u1, v1], [u2, v2]] = d;
  const den = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
  if (!den) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      // Barycentric, with a slack of one pixel so neighbouring triangles meet.
      const l0 = ((v1 - v2) * (x - u2) + (u2 - u1) * (y - v2)) / den;
      const l1 = ((v2 - v0) * (x - u2) + (u0 - u2) * (y - v2)) / den;
      const l2 = 1 - l0 - l1;
      if (l0 < -0.02 || l1 < -0.02 || l2 < -0.02) continue;
      const sx = Math.round(l0 * s[0][0] + l1 * s[1][0] + l2 * s[2][0]) - ox;
      const sy = Math.round(l0 * s[0][1] + l1 * s[1][1] + l2 * s[2][1]) - oy;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      const si = (sy * img.width + sx) * 4;
      const a = img.data[si + 3] / 255;
      if (a < 0.02) continue;
      const di = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        dst.data[di + c] = img.data[si + c] * a + dst.data[di + c] * (1 - a);
      }
    }
  }
}

function renderFrame(phase) {
  const out = new PNG({ width: W, height: H });
  out.data.set(backdrop.data);
  for (const { rig: t, img } of tails) {
    const pose = { tailAmp: AMP, tailBias: BIAS };
    const posed = poseTail(t, tailBend(t, pose, phase, wave));
    const dst = ribsFor(posed, t.half);
    const [ox, oy] = t.origin;
    for (let i = 0; i + 1 < posed.length; i++) {
      const s0 = t.srcRibs[i];
      const s1 = t.srcRibs[i + 1];
      const d0 = dst[i];
      const d1 = dst[i + 1];
      triangle(out, img, ox, oy, [s0[0], s0[1], s1[1]], [d0[0], d0[1], d1[1]]);
      triangle(out, img, ox, oy, [s0[0], s1[1], s1[0]], [d0[0], d1[1], d1[0]]);
    }
  }
  return out;
}

const cw = Math.floor(W / SHRINK);
const ch = Math.floor(H / SHRINK);
const sheet = new PNG({ width: cw * FRAMES + 4 * (FRAMES - 1), height: ch });
sheet.data.fill(210);
for (let f = 0; f < FRAMES; f++) {
  // One full wag across the strip, so the extremes are both shown.
  const frame = renderFrame((f / FRAMES) * Math.PI * 2 + Math.PI / 2);
  const dx = f * (cw + 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const s = (y * SHRINK * W + x * SHRINK) * 4;
      const d = (y * sheet.width + x + dx) * 4;
      sheet.data[d] = frame.data[s];
      sheet.data[d + 1] = frame.data[s + 1];
      sheet.data[d + 2] = frame.data[s + 2];
      sheet.data[d + 3] = 255;
    }
  }
}
writeFileSync(join(LAYERS, "_tailpreview.png"), PNG.sync.write(sheet));
console.log(`amp ${AMP}deg bias ${BIAS}deg, ${FRAMES} frames -> layers/_tailpreview.png`);
