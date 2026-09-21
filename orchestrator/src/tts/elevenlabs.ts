import type { Emotion } from "../persona.js";
import { toSpokenText } from "./typecast.js";

// Same contract as typecast.ts: a failure is logged and swallowed, because the
// voice is a garnish on the Discord reply and must never cost her a message.

const API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
// eleven_v3 is the model whose Korean came out natural on Hina in listening
// tests; the older multilingual and turbo models kept a Japanese accent.
const MODEL = "eleven_v3";
const TIMEOUT_MS = 25_000;

// v3 reads bracketed audio tags as performance directions rather than speech.
// Only emotions with an unambiguous tag get one; the rest are left to the
// voice's own delivery. Set ELEVENLABS_EMOTION_TAGS=off to drop them entirely.
const TAGS: Partial<Record<Emotion, string>> = {
  happy: "[excited]",
  sad: "[sorrowful]",
  angry: "[frustrated]",
  surprised: "[gasps]",
  embarrassed: "[nervous]",
};

let warnedMissingKey = false;

export function elevenLabsEnabled(): boolean {
  const ready = Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
  if (!ready && !warnedMissingKey) {
    warnedMissingKey = true;
    console.warn("[tts] ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set — voice disabled");
  }
  return ready;
}

/**
 * MP3 chunks as ElevenLabs produces them, or null when voice is off, the text
 * is empty, or the request was refused. v3 needs ~3s to finish a sentence but
 * starts sending audio after ~0.7s, so playing chunks as they arrive is what
 * makes her sound like she answers straight away.
 *
 * `signal` cancels the request — a newer reply supersedes this one, and there
 * is no point paying for audio nobody will hear.
 */
export async function synthesizeStream(
  text: string,
  emotion: Emotion,
  signal: AbortSignal
): Promise<AsyncGenerator<Buffer> | null> {
  if (!elevenLabsEnabled()) return null;

  const spoken = toSpokenText(text);
  if (!spoken) return null;

  const tag = process.env.ELEVENLABS_EMOTION_TAGS === "off" ? undefined : TAGS[emotion];

  try {
    const res = await fetch(
      `${API_URL}/${process.env.ELEVENLABS_VOICE_ID}/stream?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: tag ? `${tag} ${spoken}` : spoken, model_id: MODEL }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      }
    );

    if (!res.ok || !res.body) {
      const hint =
        res.status === 401 ? " (check API key)" : res.status === 402 || res.status === 429 ? " (quota or rate limit)" : "";
      console.error(`[tts] elevenlabs ${res.status}${hint}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }

    return chunksOf(res.body);
  } catch (err) {
    if (!signal.aborted) console.error("[tts] synthesis failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function* chunksOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.length) yield Buffer.from(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
