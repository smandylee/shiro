// Build a bendable rig for the tail.
//
// Rotating the tail about a hip joint makes it sweep like a stick. A real tail
// BENDS: a wave runs from the root to the tip and the tip sweeps furthest and
// latest. To do that we need the tail's centreline, so this walks the actual
// pixels and extracts one.
//
// Three things this has to work around:
//   1. See-through completes every part as if nothing covered it, so the tail
//      mask carries a large invented slab lying behind her blouse. Averaged
//      into a centreline it drives the spine straight through her chest, so the
//      slab is trimmed away first (keeping a skirt tucked under the body edge,
//      so bending can't expose a cut edge).
//   2. What's left is two separate visible runs — the slim tail curling up on
//      her right, and the fluffy one sweeping down on her left — because the
//      middle passes behind her torso. Each gets its own spine.
//   3. Which end is the root isn't obvious from the mask. The root is the end
//      that disappears behind her, i.e. the one nearer her centre line.
//
// Output: tail-a.png / tail-b.png (trimmed art) and tail-rig.json (spines).
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAYERS = join(ROOT, "layers");
const SEETHROUGH = join(ROOT, "seethrough", "out", "shiro_base");

const manifest = JSON.parse(readFileSync(join(LAYERS, "layers.json"), "utf8"));
const W = manifest.canvas.width;
const H = manifest.canvas.height;
const N = W * H;

const NODES = 24; // spine points per tail
const SKIRT = 70; // px of tail kept behind the body edge, so a bend can't expose the cut
const MIN_COMPONENT = 20000;

// Both the pre-rig names and the rigged ones, so re-running this over its own
// output finds the tail slot instead of throwing.
const TAIL_IDS = new Set(["tail-base", "tail-tip", "tail-a", "tail-b"]);
const tailLayer = manifest.layers.find((l) => TAIL_IDS.has(l.id));
if (!tailLayer) throw new Error("no tail layer in layers.json - run build-layers.mjs first");
const tailDepth = tailLayer.depth;

/* ---------- masks ---------- */

const src = PNG.sync.read(readFileSync(join(SEETHROUGH, "tail.png")));
const tail = new Uint8Array(N);
for (let p = 0; p < N; p++) if (src.data[p * 4 + 3] >= 32) tail[p] = 1;

const occluder = new Uint8Array(N);
for (const l of manifest.layers) {
  if (TAIL_IDS.has(l.id) || l.depth >= tailDepth) continue;
  const png = PNG.sync.read(readFileSync(join(LAYERS, l.file)));
  for (let p = 0; p < N; p++) if (png.data[p * 4 + 3] >= 128) occluder[p] = 1;
}

const visible = new Uint8Array(N);
for (let p = 0; p < N; p++) if (tail[p] && !occluder[p]) visible[p] = 1;

/* ---------- helpers ---------- */

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** 4-connected BFS over `mask`; returns the distance field and the last pixel reached. */
function bfs(seeds, mask, limit = Infinity) {
  const dist = new Int32Array(N).fill(-1);
  const queue = [];
  for (const p of seeds) {
    dist[p] = 0;
    queue.push(p);
  }
  let last = seeds[0] ?? -1;
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head];
    if (dist[p] >= limit) continue;
    last = p;
    const x = p % W;
    const y = (p / W) | 0;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const q = ny * W + nx;
      if (mask[q] && dist[q] < 0) {
        dist[q] = dist[p] + 1;
        queue.push(q);
      }
    }
  }
  return { dist, last };
}

function components(mask) {
  const seen = new Uint8Array(N);
  const out = [];
  for (let start = 0; start < N; start++) {
    if (!mask[start] || seen[start]) continue;
    const cells = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      cells.push(p);
      const x = p % W;
      const y = (p / W) | 0;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (mask[q] && !seen[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    out.push(cells);
  }
  return out.sort((a, b) => b.length - a.length);
}

/* ---------- one tail ---------- */

function buildTail(cells, name) {
  const mask = new Uint8Array(N);
  for (const p of cells) mask[p] = 1;

  // Geodesic diameter: farthest point from anywhere, then farthest from that.
  const a = bfs([cells[0]], mask).last;
  const { dist: fromA, last: b } = bfs([a], mask);
  // The root is the end that runs behind her body — the one nearer her centre.
  const ax = a % W;
  const bx = b % W;
  const root = Math.abs(ax - W / 2) < Math.abs(bx - W / 2) ? a : b;
  const tip = root === a ? b : a;
  const span = fromA[b];

  const { dist } = bfs([root], mask);
  const step = span / (NODES - 1);

  // Centroid of each distance band, plus how far the band reaches sideways.
  const sums = Array.from({ length: NODES }, () => ({ x: 0, y: 0, n: 0 }));
  for (const p of cells) {
    const d = dist[p];
    if (d < 0) continue;
    const i = Math.min(NODES - 1, Math.round(d / step));
    const s = sums[i];
    s.x += p % W;
    s.y += (p / W) | 0;
    s.n++;
  }
  let spine = sums.map((s, i) => (s.n ? [s.x / s.n, s.y / s.n] : null));
  // Bands can come out empty where the tail is thin; interpolate through them.
  for (let i = 0; i < NODES; i++) {
    if (spine[i]) continue;
    let lo = i - 1;
    while (lo >= 0 && !spine[lo]) lo--;
    let hi = i + 1;
    while (hi < NODES && !spine[hi]) hi++;
    if (lo < 0) spine[i] = spine[hi];
    else if (hi >= NODES) spine[i] = spine[lo];
    else {
      const t = (i - lo) / (hi - lo);
      spine[i] = [
        spine[lo][0] + (spine[hi][0] - spine[lo][0]) * t,
        spine[lo][1] + (spine[hi][1] - spine[lo][1]) * t,
      ];
    }
  }

  // Band centroids jitter; a light smoothing pass keeps the chain from kinking.
  for (let pass = 0; pass < 3; pass++) {
    const next = spine.map((v) => v.slice());
    for (let i = 1; i < NODES - 1; i++) {
      next[i][0] = (spine[i - 1][0] + 2 * spine[i][0] + spine[i + 1][0]) / 4;
      next[i][1] = (spine[i - 1][1] + 2 * spine[i][1] + spine[i + 1][1]) / 4;
    }
    spine = next;
  }

  // Half-width: how far the art reaches ACROSS the spine. Straight-line radius
  // is no good on a curve — it picks up pixels further along the tail and blows
  // the ribs up until neighbouring ones cross, which tears the warp apart. Only
  // the component perpendicular to the local tangent counts.
  const normals = spine.map((p, i) => {
    const a = spine[Math.max(0, i - 1)];
    const b = spine[Math.min(NODES - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [-dy / len, dx / len];
  });

  const perps = Array.from({ length: NODES }, () => []);
  for (const p of cells) {
    const d = dist[p];
    if (d < 0) continue;
    const i = Math.min(NODES - 1, Math.round(d / step));
    const dx = (p % W) - spine[i][0];
    const dy = ((p / W) | 0) - spine[i][1];
    perps[i].push(Math.abs(dx * normals[i][0] + dy * normals[i][1]));
  }
  // A high percentile rather than the max, so a few stray fur pixels don't
  // stretch the rib past its neighbours.
  const half = perps.map((list) => {
    if (!list.length) return 0;
    list.sort((a, b) => a - b);
    return list[Math.min(list.length - 1, Math.floor(list.length * 0.98))];
  });
  for (let i = 0; i < NODES; i++) half[i] = half[i] * 1.3 + 10;
  // Widths jitter band to band; smooth them or the silhouette ripples.
  for (let pass = 0; pass < 2; pass++) {
    const next = half.slice();
    for (let i = 1; i < NODES - 1; i++) next[i] = (half[i - 1] + 2 * half[i] + half[i + 1]) / 4;
    for (let i = 0; i < NODES; i++) half[i] = next[i];
  }
  // The root band is a cut edge, not a real tail end — widen it so the skirt
  // tucked under her body stays covered.
  half[0] = Math.max(half[0], half[1]) * 1.4;

  // One run points up the frame and the other points down, so the same joint
  // rotation would throw their tips to opposite sides of the screen. They are
  // two glimpses of one tail, so flip the run that hangs downward and both tips
  // sweep the same way.
  const dir = ((tip / W) | 0) < ((root / W) | 0) ? 1 : -1;

  console.log(
    `${name}: ${cells.length}px  root ${root % W},${(root / W) | 0} -> tip ${tip % W},${
      (tip / W) | 0
    }  span ${span}px  half ${Math.round(Math.min(...half))}..${Math.round(Math.max(...half))}  dir ${dir}`
  );
  return {
    dir,
    spine: spine.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
    half: half.map((v) => Math.round(v * 10) / 10),
  };
}

/* ---------- run ---------- */

const comps = components(visible).filter((c) => c.length >= MIN_COMPONENT);
console.log(`visible tail runs: ${comps.map((c) => c.length).join(", ")}`);
if (comps.length < 2) throw new Error("expected two visible tail runs");

// Keep the two real runs; the rest are slivers peeking between arm and body.
const runs = comps.slice(0, 2).sort((a, b) => (a[0] % W) - (b[0] % W));

const rig = { canvas: { width: W, height: H }, tails: [] };
const names = ["tail-a", "tail-b"];

runs.forEach((cells, idx) => {
  const name = names[idx];
  const mask = new Uint8Array(N);
  for (const p of cells) mask[p] = 1;

  // Grow back under the body so the cut edge stays hidden when the tail bends.
  const { dist: grow } = bfs(cells, tail, SKIRT);
  const keep = new Uint8Array(N);
  let kept = 0;
  for (let p = 0; p < N; p++) {
    if (grow[p] >= 0) {
      keep[p] = 1;
      kept++;
    }
  }

  // Crop tight. The warp redraws this image ~46 times a frame (two triangles per
  // strip), so handing the compositor a full 1280x1280 sheet each time is waste.
  let x1 = W;
  let y1 = H;
  let x2 = -1;
  let y2 = -1;
  for (let p = 0; p < N; p++) {
    if (!keep[p]) continue;
    const x = p % W;
    const y = (p / W) | 0;
    if (x < x1) x1 = x;
    if (y < y1) y1 = y;
    if (x > x2) x2 = x;
    if (y > y2) y2 = y;
  }
  const cw = x2 - x1 + 1;
  const ch = y2 - y1 + 1;
  const out = new PNG({ width: cw, height: ch });
  out.data.fill(0);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const p = (y + y1) * W + (x + x1);
      if (!keep[p]) continue;
      const s = p * 4;
      const d = (y * cw + x) * 4;
      out.data[d] = src.data[s];
      out.data[d + 1] = src.data[s + 1];
      out.data[d + 2] = src.data[s + 2];
      out.data[d + 3] = src.data[s + 3];
    }
  }
  writeFileSync(join(LAYERS, `${name}.png`), PNG.sync.write(out));

  const built = buildTail(cells, name);
  // The run on her left sits nearer the base of the real tail, so the wave
  // reaches it first; the far run answers a beat later.
  const lead = built.dir < 0 ? 0.9 : 0;
  rig.tails.push({ id: name, file: `${name}.png`, origin: [x1, y1], lead, ...built });
  console.log(`  ${name}.png  ${cw}x${ch} at ${x1},${y1}  (${kept}px kept)`);
});

writeFileSync(join(LAYERS, "tail-rig.json"), `${JSON.stringify(rig, null, 2)}\n`);
console.log("layers/tail-rig.json");

/* ---- swap the rigged tails into the manifest ---- */

const first = manifest.layers.findIndex((l) => TAIL_IDS.has(l.id));
const rest = manifest.layers.filter((l) => !TAIL_IDS.has(l.id));
const replacement = rig.tails.map((t) => ({
  id: t.id,
  file: t.file,
  // The art is cropped to its own bbox; x/y put it back. The renderer's warp
  // path uses the rig's origin, but the plain tools blit by x/y.
  x: t.origin[0],
  y: t.origin[1],
  // Same slot in the stack the old tail layers held: behind everything but her
  // back hair. `warp` tells the renderer to bend it rather than blit it.
  depth: tailDepth,
  group: "body",
  warp: "tail",
}));
rest.splice(first, 0, ...replacement);
manifest.layers = rest;
// The old rotate-about-a-hinge groups are gone; the spine replaces them.
delete manifest.groups.tail;
delete manifest.groups.tail_tip;
writeFileSync(join(LAYERS, "layers.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`layers/layers.json  (${manifest.layers.length} layers)`);
