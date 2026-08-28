// How each emotion looks in motion. A cat says more with its tail and ears than
// with its face, so those carry most of the signal.
//
// Angles are degrees, speeds are cycles per second, offsets are source pixels.
//
// tailAmp / tailBias are degrees of bend spread along the WHOLE tail, not a
// rotation about a joint: the chain in tail.js divides them across its segments,
// weighted toward the tip. So 30 means "the tail curves through about 30 degrees
// from root to tip at full swing", which lands around a 90px sweep of the tip.
// Measured with `node tools/preview-tail.mjs <amp>`; it stays clean past 45.
//
// The head angles are a different matter: they rotate about a pivot far from the
// pixels they move (~880px from the top of her hair), so a few degrees already
// travels a long way. Double digits there read as the drawing being yanked.
const BASE = {
  tailAmp: 14,
  tailSpeed: 0.26,
  tailBias: 0,
  tailWave: "sine",
  earAngle: 0,
  earTwitch: 0,
  headTilt: 0,
  headBob: 0,
  breath: 1,
  blinkEvery: 4.5,
  gaze: [0, 0],
};

export const EMOTION_POSES = {
  neutral: {},

  happy: {
    tailAmp: 34,
    tailSpeed: 0.8,
    tailBias: 5,
    earAngle: 3,
    headTilt: 2.5,
    breath: 1.3,
    blinkEvery: 3.8,
  },

  sad: {
    tailAmp: 6,
    tailSpeed: 0.12,
    tailBias: -10,
    earAngle: -9,
    headTilt: -1.5,
    headBob: 8,
    breath: 0.7,
    blinkEvery: 6.5,
    gaze: [0, 9],
  },

  angry: {
    tailAmp: 30,
    tailSpeed: 1.35,
    tailBias: 6,
    tailWave: "flick",
    earAngle: -12,
    headTilt: 0,
    headBob: -4,
    breath: 1.5,
    blinkEvery: 5.5,
  },

  surprised: {
    tailAmp: 8,
    tailSpeed: 0.2,
    tailBias: 12,
    tailWave: "still",
    earAngle: 6,
    headBob: -6,
    breath: 1.6,
    blinkEvery: 8,
    gaze: [0, -5],
  },

  embarrassed: {
    tailAmp: 12,
    tailSpeed: 0.45,
    tailBias: -8,
    earAngle: -5,
    headTilt: -5,
    headBob: 6,
    breath: 1.2,
    blinkEvery: 2.6,
    gaze: [-12, 6],
  },

  thinking: {
    tailAmp: 18,
    tailBias: 2,
    tailSpeed: 0.6,
    tailWave: "flick",
    earAngle: 1.5,
    earTwitch: 5,
    headTilt: 7,
    breath: 0.9,
    blinkEvery: 5,
    gaze: [7, -10],
  },

  love: {
    tailAmp: 30,
    tailSpeed: 0.4,
    tailBias: 6,
    earAngle: 4,
    headTilt: 4,
    breath: 1.1,
    blinkEvery: 4,
    gaze: [0, 1],
  },
};

export function poseFor(emotion) {
  return { ...BASE, ...(EMOTION_POSES[emotion] ?? {}) };
}

/** Blend two poses; t=0 is `from`, t=1 is `to`. Non-numeric fields snap at the midpoint. */
export function blendPose(from, to, t) {
  const out = {};
  for (const key of Object.keys(BASE)) {
    const a = from[key];
    const b = to[key];
    if (typeof a === "number" && typeof b === "number") {
      out[key] = a + (b - a) * t;
    } else if (Array.isArray(a) && Array.isArray(b)) {
      out[key] = a.map((v, i) => v + (b[i] - v) * t);
    } else {
      out[key] = t < 0.5 ? a : b;
    }
  }
  return out;
}
