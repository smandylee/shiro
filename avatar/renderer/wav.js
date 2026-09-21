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
const MIN_LAG_RATIO = 1 / 400; // pitch up to 400 Hz
const MAX_LAG_RATIO = 1 / 80; // pitch down to 80 Hz
const VOICED_PERIODICITY = 0.5;

/**
 * Whether recorded audio is a person speaking, as opposed to loud noise. A
 * language model given a fan, keyboard clicks or a hum will happily "hear" a
 * sentence in it, so that is ruled out before anything is sent.
 *
 * Speech is voiced: its sound repeats at a pitch (80-400 Hz) that keeps
 * changing, and its loudness rises and falls with the syllables. A hum repeats
 * but never changes; a fan or white noise doesn't repeat at all; clicks are
 * over in a moment.
 */
export function looksLikeSpeech(blocks, sampleRate) {
  let length = 0;
  for (const b of blocks) length += b.length;
  const x = new Float32Array(length);
  let at = 0;
  for (const b of blocks) {
    x.set(b, at);
    at += b.length;
  }

  const minLag = Math.max(2, Math.floor(sampleRate * MIN_LAG_RATIO));
  const maxLag = Math.floor(sampleRate * MAX_LAG_RATIO);
  const energies = [];
  const pitches = [];

  for (let start = 0; start + FRAME + maxLag <= x.length; start += HOP) {
    const frame = x.subarray(start, start + FRAME);
    const e = rms(frame);
    if (e < ACTIVE_RMS) continue;
    energies.push(e);

    let best = 0;
    let bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let cross = 0;
      let a = 0;
      let b = 0;
      for (let i = 0; i < FRAME; i++) {
        const p = x[start + i];
        const q = x[start + i + lag];
        cross += p * q;
        a += p * p;
        b += q * q;
      }
      const r = cross / Math.sqrt(a * b + 1e-12);
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
    if (best > VOICED_PERIODICITY) pitches.push(sampleRate / bestLag);
  }

  if (energies.length === 0 || pitches.length < 12) return false; // under a quarter second of voice
  if (pitches.length / energies.length < 0.25) return false; // mostly not voiced: noise, clicks

  const mean = (v) => v.reduce((s, n) => s + n, 0) / v.length;
  const stdev = (v) => Math.sqrt(mean(v.map((n) => (n - mean(v)) ** 2)));
  const pitchMoves = stdev(pitches) >= 4; // Hz: a hum stays put
  const loudnessMoves = stdev(energies) / mean(energies) >= 0.6; // syllables rise and fall
  return pitchMoves || loudnessMoves;
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
