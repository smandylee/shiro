// Which See-through classes actually carry pixels for this character?
// The exporter writes a file per class whether or not the drawing has that part,
// so "file exists" says nothing — count real pixels instead.
import { PNG } from "pngjs";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "seethrough", "out", "shiro_base");
const A = 160;

const files = readdirSync(SRC)
  .filter((f) => f.endsWith(".png") && !f.endsWith("_depth.png"))
  .sort();

console.log("part                  visible px      bounds");
for (const f of files) {
  const png = PNG.sync.read(readFileSync(join(SRC, f)));
  const { width: w, height: h, data } = png;
  let n = 0;
  let x1 = w;
  let y1 = h;
  let x2 = -1;
  let y2 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] >= A) {
        n++;
        if (x < x1) x1 = x;
        if (y < y1) y1 = y;
        if (x > x2) x2 = x;
        if (y > y2) y2 = y;
      }
    }
  }
  const box = n ? `${x1},${y1},${x2},${y2}` : "-";
  const mark = n > 2000 ? "  <-- has content" : "";
  console.log(`${f.replace(".png", "").padEnd(20)} ${String(n).padStart(9)}   ${box}${mark}`);
}
