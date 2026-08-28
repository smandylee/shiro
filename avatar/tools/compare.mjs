// Crop the same window out of the source image and out of the composited layer
// stack, side by side, so a "looks off" can be checked against the original
// instead of argued about.
//
//   node tools/compare.mjs x1 y1 x2 y2
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [x1, y1, x2, y2] = process.argv.slice(2, 6).map(Number);
if ([x1, y1, x2, y2].some(Number.isNaN)) {
  console.error("usage: node tools/compare.mjs x1 y1 x2 y2");
  process.exit(1);
}

const src = PNG.sync.read(
  readFileSync(join(ROOT, "seethrough", "out", "shiro_base", "src_img.png"))
);
const mine = PNG.sync.read(readFileSync(join(ROOT, "layers", "_composite.png")));

const w = x2 - x1;
const h = y2 - y1;
const GAP = 12;
const out = new PNG({ width: w * 2 + GAP, height: h });
out.data.fill(0);

function blit(png, dx) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y + y1) * png.width + (x + x1)) * 4;
      const d = (y * out.width + (x + dx)) * 4;
      const a = png.data[s + 3] / 255;
      // Composite over white so transparency doesn't read as a dark hole.
      out.data[d] = png.data[s] * a + 255 * (1 - a);
      out.data[d + 1] = png.data[s + 1] * a + 255 * (1 - a);
      out.data[d + 2] = png.data[s + 2] * a + 255 * (1 - a);
      out.data[d + 3] = 255;
    }
  }
}

blit(src, 0);
blit(mine, w + GAP);

const dest = join(ROOT, "layers", "_compare.png");
writeFileSync(dest, PNG.sync.write(out));
console.log(`left = original, right = layer stack   [${x1},${y1} ${w}x${h}]`);
console.log(dest);
