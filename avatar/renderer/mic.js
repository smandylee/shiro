import { rms, encodeWav, speechStats, toBase64 } from "./wav.js";

// Listens to the owner through the microphone until they finish speaking. It
// only runs between the owner pressing the hotkey and the utterance ending;
// nothing is kept once the audio has been handed back.

const SAMPLE_RATE = 16000;
const BLOCK = 4096;
// Louder than this counts as speech (RMS, 0..1). Echo cancellation and noise
// suppression are on, so room hum stays well below it.
const SPEECH_RMS = 0.015;
const MIN_SPEECH_MS = 250;
// This long a pause after speaking ends the utterance. It comes off every reply's
// wait, so it is kept short; pressing the hotkey again sends immediately anyway.
const END_SILENCE_MS = 1000;
// Pressed the hotkey and said nothing.
const NO_SPEECH_MS = 8000;
const MAX_MS = 30_000;

/**
 * Starts listening. `onDone(audio, reason)` is called exactly once: `audio` is
 * `{ mime, data }` (base64 WAV) or null when there wasn't any speech, and
 * `reason` is "silence", "manual", "max" when audio was sent, and "no-speech",
 * "short" or "noise" when it wasn't (nothing said, too brief, or not a voice).
 * Returns `{ stop(), cancel() }`; stop() ends it now and sends what was heard.
 */
export async function startListening({ onDone }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const rate = ctx.sampleRate;
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(BLOCK, 1, 1);
  // The processor only runs while it is connected onward; a muted gain keeps it running silently.
  const mute = ctx.createGain();
  mute.gain.value = 0;

  const blocks = [];
  const msPerBlock = (BLOCK / rate) * 1000;
  let speechMs = 0;
  let silenceMs = 0;
  let totalMs = 0;
  let finished = false;

  function release() {
    processor.onaudioprocess = null;
    try {
      source.disconnect();
      processor.disconnect();
      mute.disconnect();
    } catch {
      /* already disconnected */
    }
    for (const track of stream.getTracks()) track.stop();
    ctx.close().catch(() => {});
  }

  function finish(reason) {
    if (finished) return;
    finished = true;
    release();
    if (speechMs < MIN_SPEECH_MS) return onDone(null, reason === "no-speech" ? "no-speech" : "short");
    // Loud, but is it an utterance? A steady fan or hum must not be sent as if it were words.
    const stats = speechStats(blocks, rate);
    console.log(
      `[mic] recorded ${(totalMs / 1000).toFixed(1)}s (${reason}): floor ${stats.floor.toFixed(4)}, loud ${stats.loud.toFixed(4)}, ` +
        `contrast ${stats.contrast.toFixed(1)}x -> ${stats.speech ? "sent" : "turned away as noise"}`
    );
    if (!stats.speech) return onDone(null, "noise");
    onDone({ mime: "audio/wav", data: toBase64(encodeWav(blocks, rate)) }, reason);
  }

  processor.onaudioprocess = (e) => {
    if (finished) return;
    blocks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    totalMs += msPerBlock;

    if (rms(blocks[blocks.length - 1]) > SPEECH_RMS) {
      speechMs += msPerBlock;
      silenceMs = 0;
    } else if (speechMs >= MIN_SPEECH_MS) {
      silenceMs += msPerBlock;
    }

    if (speechMs >= MIN_SPEECH_MS && silenceMs >= END_SILENCE_MS) finish("silence");
    else if (speechMs < MIN_SPEECH_MS && totalMs >= NO_SPEECH_MS) finish("no-speech");
    else if (totalMs >= MAX_MS) finish("max");
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  return {
    stop: () => finish("manual"),
    cancel: () => {
      if (finished) return;
      finished = true;
      release();
    },
  };
}
