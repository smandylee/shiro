// What the microphone gives us, as something Gemini accepts: a 16-bit mono WAV.
// Kept free of browser APIs so it can be tested in Node.

/** Loudness of a block of samples (root mean square, 0..1). */
export function rms(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

const FRAME = 480; // 30 ms at 16 kHz
const HOP = 320; // 20 ms
const ACTIVE_RMS = 0.008;
// A reply like "응" or "맞아" is only a couple of tenths of a second; this must let it through.
const MIN_ACTIVE_FRAMES = 5; // 100 ms above the room's floor
const MIN_CONTRAST = 2.5;

/**
 * Whether a recording holds an utterance, as opposed to a steady noise that
 * merely stays loud. A person speaking is much louder than the room around it
 * and then stops: on a real headset microphone speech measured 0.05-0.09 against
 * a floor of 0.003, twenty times louder. A fan, a hum or white noise has no such
 * contrast - it is as loud at the start as at the end.
 *
 * This is deliberately not a pitch detector. Tried first, it turned away real
 * speech: after the microphone's own noise suppression, a voice showed almost no
 * clear pitch. Sounds that do have contrast but aren't speech (a keyboard, a
 * chime) are left to the server, which asks a model whether a person is talking
 * before anything she says is let out.
 */
export function looksLikeSpeech(blocks, sampleRate) {
  return speechStats(blocks, sampleRate).speech;
}

/** The numbers behind looksLikeSpeech, for finding out why a recording was turned away. */
export function speechStats(blocks, _sampleRate) {
  let length = 0;
  for (const b of blocks) length += b.length;
  const x = new Float32Array(length);
  let at = 0;
  for (const b of blocks) {
    x.set(b, at);
    at += b.length;
  }

  const energies = [];
  for (let start = 0; start + FRAME <= x.length; start += HOP) {
    energies.push(rms(x.subarray(start, start + FRAME)));
  }
  if (energies.length === 0) {
    return { frames: 0, activeFrames: 0, floor: 0, loud: 0, contrast: 0, speech: false };
  }

  const sorted = [...energies].sort((a, b) => a - b);
  // The room's floor: what it is like most of the time it isn't being spoken over.
  const floor = sorted[Math.floor(0.1 * (sorted.length - 1))];
  // How loud the loudest stretch is (its 12 loudest frames, so a short utterance still counts).
  const top = sorted.slice(-MIN_ACTIVE_FRAMES);
  const loud = top.reduce((s, v) => s + v, 0) / top.length;
  const activeFrames = energies.filter((e) => e >= ACTIVE_RMS).length;
  const contrast = loud / Math.max(floor, 1e-4);

  return {
    frames: energies.length,
    activeFrames,
    floor,
    loud,
    contrast,
    speech: activeFrames >= MIN_ACTIVE_FRAMES && contrast >= MIN_CONTRAST,
  };
}

/** Joins recorded blocks (Float32Array, -1..1) into a 16-bit mono WAV file. */
export function encodeWav(blocks, sampleRate) {
  let length = 0;
  for (const b of blocks) length += b.length;

  const bytes = new Uint8Array(44 + length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  text(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, length * 2, true);

  let offset = 44;
  for (const b of blocks) {
    for (let i = 0; i < b.length; i++) {
      const s = Math.max(-1, Math.min(1, b[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return bytes;
}

export function toBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000; // String.fromCharCode chokes on very long argument lists
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
