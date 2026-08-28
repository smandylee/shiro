// Stack the manifest's layers in draw order into one PNG, so what the avatar
// actually renders can be compared against See-through's own reconstruction.
// Anything present in the reconstruction but missing here is a layer we dropped.
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAYERS = join(ROOT, "layers");
const manifest = JSON.parse(readFileSync(join(LAYERS, "layers.json"), "utf8"));
const { width: W, height: H } = manifest.canvas;

const out = new PNG({ width: W, height: H });
out.data.fill(0);

// Layers are not all full-canvas any more: the rigged tails are cropped to
// their own bbox and carry the offset that puts them back.
for (const layer of manifest.layers) {
  const png = PNG.sync.read(readFileSync(join(LAYERS, layer.file)));
  const ox = layer.x ?? 0;
  const oy = layer.y ?? 0;
  for (let y = 0; y < png.height; y++) {
    const dy = y + oy;
    if (dy < 0 || dy >= H) continue;
    for (let x = 0; x < png.width; x++) {
      const dx = x + ox;
      if (dx < 0 || dx >= W) continue;
      const s = (y * png.width + x) * 4;
      const a = png.data[s + 3] / 255;
      if (a === 0) continue;
      const d = (dy * W + dx) * 4;
      const inv = 1 - a;
      out.data[d] = png.data[s] * a + out.data[d] * inv;
      out.data[d + 1] = png.data[s + 1] * a + out.data[d + 1] * inv;
      out.data[d + 2] = png.data[s + 2] * a + out.data[d + 2] * inv;
      out.data[d + 3] = Math.min(255, png.data[s + 3] + out.data[d + 3] * inv);
    }
  }
}

const dest = join(ROOT, "layers", "_composite.png");
writeFileSync(dest, PNG.sync.write(out));
console.log(`composited ${manifest.layers.length} layers -> ${dest}`);
