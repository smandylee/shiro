# mesh/ — the engine that draws the head and body

This is the engine of [mesh-avatar-studio](https://github.com/shinshin86/mesh-avatar-studio) (MIT,
`LICENSE-mesh-avatar-studio`), bundled in. It deforms one illustration as a WebGL mesh to do **left–right head
turns**, closing the eyes, smiling eyes and opening the mouth.

## How it is combined with the rest

`renderer/meshface.js` wraps the engine, and `renderer/app.js` stacks everything on one canvas:

1. the tail (the existing layers, with chain bending);
2. the ears (the existing layers: emotion angle plus a flick);
3. the **mesh canvas** — head, hair, face and body: the picture without the tail and ears (`built/base.png`).

Drawing the ears after the tail and below the mesh differs from the original layer order by only 1,633 pixels (the
tips of the ear fur). The ears tilt along with the mesh head's roll and use the mesh head's pivot.

Emotions are mapped onto the engine's expressions by the `EXPRESSION` table in `meshface.js`. The engine runs gaze,
blinking and a small head sway by itself (auto mode), and while her voice plays, `setVoice` passes the volume in so
the mouth moves.

**To turn it off:** `"mesh": false` in `avatar/config.json`. If the engine or its assets are missing, or startup
fails, it falls back to the plain layer renderer automatically (`[avatar] head and body: layered`).

## Files

| | |
|---|---|
| `engine.js` | The engine bundle (esbuild, left readable). It contains the changes below. |
| `rig.json` | The rig: eye outlines, face regions, hair strands. |
| `built/` | Mesh layer PNGs, `hairmask.png`, the smiling-eye sprites. |
| `build/make_draft.py`, `build/make_smile.py`, `build/build_mesh_source.py` | Scripts that made the rig draft, the smiling-eye variants and the mesh source image (tail, ears and mouth removed). Paths are those of the machine they were made on. |

## Changes made to the engine (against the original)

These were made to suit Shiro in a scratch folder. **If you fetch the original engine again, reapply this list.**

- `rig.js` — the gap between the eyes narrows as the head turns (`TURN_GAP=0.1`, proportional to the square of the
  angle) and the eye width changes by `TURN_STRETCH=0.15`. When the eyes close, the eyelid-crease layer disappears
  completely (the broken line used to look like an eyebrow).
- `sprites.js` — an incomplete picture set no longer switches the deformations off (`complete`). Smiling eyes alone are
  enough for blinking and mouth opening to work.
- `createMeshAvatar.js` — eyelid and mouth deformation are switched off only when the above `complete` is set, and
  when the head turns both irises shift slightly the same way (`TURN_IRIS=4` px; it used to look cross-eyed).
- `renderer.js` — a fixed size for a canvas that is not attached to the screen (`dataset.fixedSize`).
- `rig.js` — the nose moves as one piece with the face. (It used to be pushed a further 8 px sideways and 6 px
  vertically when the head turned, so it floated above the face.)
- `sprites.js`, `createMeshAvatar.js` — **the mouth is one drawing, only stretched and squashed vertically**
  (`singleMouth` in `sprites.json`). The engine's own mouth is in a different art style, so the moment she started
  to speak it looked like another mouth. The mouth is removed from the mesh source and drawn separately as
  `built/sprites/mouth_a.png`: 0.25–1.2× by volume while speaking, 1× otherwise (slightly more with some
  expressions).

## Changes to the art

- The nose highlight (`nose.png`) is merged at 55% opacity. What See-through decomposed was a flat white blob without
  the original's pink glow, so it floated white on the face. The value is `0.55` in `build/build_mesh_source.py`.
  (`layers/nose.png` of the plain layer renderer is unchanged.)

## Known limits

- There are no per-vowel mouth drawings; one picture is scaled vertically.
- The smiling-eye art was drawn in code. A faint rectangular patch mark remains at the outer end of the eyes.
- Faint pixels below alpha 24 were removed (the engine draws sharply, and they showed up as pink dots).
- It is a deformation of a single picture, so large turns have limited depth.
