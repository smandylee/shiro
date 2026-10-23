# The avatar

How a single illustration became a body that moves: the layer pipeline, the tail, the face. Written for anyone
who wants to rebuild it with their own character.

## From one picture to 21 layers

The base illustration (`avatar/shiro_base.png`) was generated with NovelAI and decomposed into 21 layers with
[See-through](https://github.com/shitagaki-lab/see-through) (`avatar/seethrough/out/`). See-through reconstructs
the parts hidden behind other parts, so when a part moves there is no hole behind it.

### The pipeline

```bash
cd avatar
node tools/build-layers.mjs      # See-through output  ->  layers/ + layers.json
node tools/build-tail-rig.mjs    # extract the tail's centre line  ->  tail-rig.json   (after build-layers)
node tools/composite.mjs         # flatten everything into one picture to check
```

The second step must not run before the first. Order matters.

The tools use `pngjs`, which is a dev dependency: `npm install` in `avatar/` first (add `--ignore-scripts` if you do
not want Electron's binary downloaded).

### Checking without launching Electron

```bash
node tools/preview-tail.mjs 34 3 5     # tail: 34° amplitude, 3 frames, bias 5
node tools/preview-face.mjs happy,sad  # expressions
node tools/compare.mjs 400 400 900 800 # original vs. layered composite, side by side
```

The output lands in `avatar/layers/_*.png` (git-ignored).

### Recording a demo GIF

`tools/record-demo.mjs` records the **real renderer** — not a mock-up — without starting Electron. The renderer only
needs the `window.shiro` object that Electron's preload script provides, so the tool serves the folder from a tiny
local server that adds a do-nothing stand-in, opens the page in headless Chrome, clicks through the emotions of the
control panel and turns the screenshots into a GIF with ffmpeg:

```bash
cd avatar
npm install --no-save puppeteer-core     # once; it is not a dependency of the app
node tools/record-demo.mjs               # writes docs/images/shiro-demo.gif
```

It needs Chrome (set `CHROME_PATH` if it is not in the usual place) and `ffmpeg` on your PATH. Run it on a machine
with a GPU: with software rendering it captures about one frame every two seconds. Re-run it whenever the rig or the
expressions change, so the picture in the README stays true.

## The rig

| Part | How it moves |
|---|---|
| **Tail** | Not rotated: **bent.** A centre line extracted from the pixels becomes a 24-joint chain, and a wave travels from root to tip (`renderer/tail.js`, a triangle warp over the chain). `tailAmp` in `emotions.js` is the angle the *whole tail* bends, not a joint angle. |
| **Ears** | Tilt with the emotion and flick now and then. |
| **Head and body** | Drawn by the [mesh engine](../avatar/mesh/README.md) so the head can **turn left and right**; the engine also drives gaze, blinking and a small sway. |
| **Hair** | Lags behind the head with a spring. |
| **Mouth** | One drawing, scaled vertically by the volume of her voice. |

Emotions arrive as tags (`neutral`, `happy`, `sad`, `angry`, `surprised`, `embarrassed`, `thinking`, `love`); each is a
set of pose values in `renderer/emotions.js`, and the renderer interpolates between them.

## Things to know before changing it

- **The tail's phase must be accumulated every frame, never computed from the clock.** With `time * speed`, the phase
  jumps whenever the speed changes and the tail whips around. Add to it each frame instead (`tailPhase` in `app.js`).
- **Eyebrows are unusable** with this character. The fringe covers them completely: tilting them 22° changes nothing
  you can see. Expressions are made with eye size, pupils, blush and mouth.
- **`face.png` is a blank face** — no eyes, mouth or brows — because See-through rebuilt it that way. That is what
  makes it possible to move or swap those parts and have clean skin show through instead of a hole.
- Build order: `build-layers.mjs`, then `build-tail-rig.mjs`.

## Expression art: what is still missing

The mouth is a single drawing ("open smile"); the rest of the mouth shapes are to be made with **inpainting**,
because generating a new picture drifts the face:

- base: `avatar/shiro_base.png` (1536×1536, left as it is);
- mask: `avatar/mouth-mask.png`;
- wanted: closed mouth, small "o", a pout, and optionally a wavy line.

1536 → 1280 is exactly 6:5, so coordinates map one-to-one and See-through does not need to run again.

The same goes for eye states (closed, smiling, wide, sad) and small effects (blush, a sweat drop). More images, not
more code, is what makes her look more alive: the code can only move the pictures it has.
