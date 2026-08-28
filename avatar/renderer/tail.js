// Bending the tail instead of swinging it.
//
// The old rig hinged the whole tail at one point, so it swept like a stick
// nailed to her hip. A real tail bends: a wave starts at the root and runs to
// the tip, which sweeps furthest and arrives last.
//
// So the tail is a chain of segments along its measured centreline. Each joint
// adds a little rotation, and every segment after it inherits that rotation —
// small angles compounding down the chain into a big, soft sweep at the tip.
//
// Canvas 2D can't sample a deformed mesh, so each strip between two ribs is
// drawn as two triangles, each with the affine transform that carries its
// source corners onto its deformed ones. Close enough at 23 strips that the
// facets don't read.

const DEG = Math.PI / 180;

/** Ribs across the spine: one line segment per node, perpendicular to the local tangent. */
function ribsFor(pts, half) {
  const n = pts.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * half[i];
    const ny = (dx / len) * half[i];
    out[i] = [
      [pts[i][0] - nx, pts[i][1] - ny],
      [pts[i][0] + nx, pts[i][1] + ny],
    ];
  }
  return out;
}

/**
 * How much of the total bend each joint carries. Near the root a tail is thick
 * and muscular and barely bends; the last third does most of the work. Weights
 * sum to 1 so `tailAmp` stays readable as "degrees of sweep at the tip",
 * independent of how many segments the spine happens to have.
 */
function bendWeights(count) {
  const w = new Array(count);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const u = count === 1 ? 1 : i / (count - 1);
    w[i] = 0.03 + Math.pow(u, 1.7);
    total += w[i];
  }
  for (let i = 0; i < count; i++) w[i] /= total;
  return w;
}

export function prepareTail(t) {
  const spine = t.spine;
  const n = spine.length;
  const seg = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = spine[i + 1][0] - spine[i][0];
    const dy = spine[i + 1][1] - spine[i][1];
    seg.push({ len: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) });
  }
  return {
    id: t.id,
    file: t.file,
    origin: t.origin,
    half: t.half,
    dir: t.dir ?? 1,
    lead: t.lead ?? 0,
    spine,
    seg,
    srcRibs: ribsFor(spine, t.half),
    weights: bendWeights(seg.length),
  };
}

/** Walk the chain, compounding each joint's rotation into everything past it. */
export function poseTail(tail, bendAt) {
  const pts = [tail.spine[0].slice()];
  let acc = 0;
  for (let i = 0; i < tail.seg.length; i++) {
    acc += bendAt(i);
    const a = tail.seg[i].angle + acc;
    pts.push([
      pts[i][0] + Math.cos(a) * tail.seg[i].len,
      pts[i][1] + Math.sin(a) * tail.seg[i].len,
    ]);
  }
  return pts;
}

/**
 * The travelling wave. `phase` advances with time; each joint samples it a
 * little later than the one before, which is what sends the wave down the tail
 * rather than flapping the whole thing in unison.
 */
export function tailBend(tail, pose, phase, waveAt) {
  const n = tail.seg.length;
  const travel = 1.5 * Math.PI; // radians of wave spread across the tail's length
  return (i) => {
    const u = n === 1 ? 1 : i / (n - 1);
    const w = waveAt(phase + tail.lead - u * travel);
    return (pose.tailBias + w * pose.tailAmp) * tail.weights[i] * tail.dir * DEG;
  };
}

/** Map one source triangle onto its deformed counterpart. */
function triangle(ctx, img, s, d, ox, oy, grow) {
  const cx = (d[0][0] + d[1][0] + d[2][0]) / 3;
  const cy = (d[0][1] + d[1][1] + d[2][1]) / 3;

  ctx.save();
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    // Nudge each corner outward from the centre. Clipping neighbouring
    // triangles along a shared edge otherwise leaves an antialiased hairline
    // between them, and 46 of those read as a seam running down the tail.
    let x = d[k][0];
    let y = d[k][1];
    const len = Math.hypot(x - cx, y - cy) || 1;
    x += ((x - cx) / len) * grow;
    y += ((y - cy) / len) * grow;
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.clip();

  const [[x0, y0], [x1, y1], [x2, y2]] = s;
  const [[u0, v0], [u1, v1], [u2, v2]] = d;
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (det) {
    const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det;
    const b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / det;
    const c = ((x1 - x0) * (u2 - u0) - (x2 - x0) * (u1 - u0)) / det;
    const e = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / det;
    ctx.transform(a, b, c, e, u0 - a * x0 - c * y0, v0 - b * x0 - e * y0);
    ctx.drawImage(img, ox, oy);
  }
  ctx.restore();
}

export function drawTail(ctx, img, tail, posed, grow = 1.1) {
  const dst = ribsFor(posed, tail.half);
  const [ox, oy] = tail.origin;
  for (let i = 0; i + 1 < posed.length; i++) {
    const s0 = tail.srcRibs[i];
    const s1 = tail.srcRibs[i + 1];
    const d0 = dst[i];
    const d1 = dst[i + 1];
    triangle(ctx, img, [s0[0], s0[1], s1[1]], [d0[0], d0[1], d1[1]], ox, oy, grow);
    triangle(ctx, img, [s0[0], s1[1], s1[0]], [d0[0], d1[1], d1[0]], ox, oy, grow);
  }
}
