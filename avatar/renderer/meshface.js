// Her head and body, drawn by the mesh-avatar-studio engine (see mesh/README.md).
//
// The engine deforms one flat illustration on a WebGL mesh, which is what lets her
// head turn and her eyes and mouth follow it. It cannot do what the layered art in
// app.js does well: the tails (they bend along their own centreline) and the ears.
// So the picture is split. This engine owns everything except tails and ears; app.js
// draws the tails behind, then the ears, then this canvas on top of them.
//
// The engine is autonomous (it wanders, glances and blinks on its own). app.js only
// tells it how she feels and whether she is speaking.

// Her emotions are named for the avatar; the engine has its own expression names.
const EXPRESSION = {
  neutral: "neutral",
  happy: "smile",
  sad: "sad",
  angry: "angry",
  surprised: "surprise",
  embarrassed: "shy",
  thinking: "neutral",
  love: "smile",
};

/**
 * Returns the face, or null when the engine or its assets are not there, so the
 * caller can carry on with the layered drawing it always had.
 */
export async function createMeshFace() {
  try {
    const res = await fetch("../mesh/rig.json");
    if (!res.ok) return null;
    const rig = await res.json();
    const { createMeshAvatarImpl } = await import("../mesh/engine.js");

    const canvas = document.createElement("canvas");
    canvas.width = rig.image.width;
    canvas.height = rig.image.height;
    canvas.dataset.fixedSize = "1"; // never laid out: its size is the picture's size
    const avatar = await createMeshAvatarImpl(canvas, {
      rig,
      assetsBase: new URL("../mesh/built/", import.meta.url).href,
      manual: true, // app.js advances it, one step per frame
      padTop: 0,
      padSide: 0,
    });

    return {
      canvas,
      width: rig.image.width,
      height: rig.image.height,
      /** The head's own pivot and roll, so the ears can follow it. */
      headPivot: [rig.head.pivotX, rig.head.pivotY],

      setEmotion(name) {
        avatar.setExpression(EXPRESSION[name] ?? "neutral");
      },

      /** level: 0..1 loudness while she is speaking, null when she is not. */
      setVoice(level) {
        avatar.setSpeaking(level !== null);
        avatar.setVoiceLevel(level ?? 0);
      },

      update(dt) {
        // advance(sec, fps) takes round(sec*fps) steps; asking for fps = 1/sec is one step.
        const step = Math.min(0.05, Math.max(1 / 240, dt));
        avatar.advance(step, 1 / step);
      },

      /** Head roll in degrees, positive clockwise, same convention as ctx.rotate. */
      rollDegrees() {
        const p = avatar.getParameters();
        const rad = (-(p.angleZ ?? 0) / 30) * rig.head.maxRoll;
        return (rad * 180) / Math.PI;
      },
    };
  } catch (err) {
    console.warn("[avatar] mesh face unavailable, using the layered drawing:", err);
    return null;
  }
}
