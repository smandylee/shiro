import type { Emotion } from "../persona.js";
import { cleanCue } from "./marks.js";
import { toPerformedText } from "./perform.js";
import { toSpokenText } from "./typecast.js";

// Same contract as typecast.ts: a failure is logged and swallowed, because the
// voice is a garnish on the Discord reply and must never cost her a message.

const API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
// eleven_v3 was the first model whose Korean came out natural on Hina; the
// older multilingual and turbo models kept a Japanese accent. v4 (2026-09-28)
// replaced it. eleven_v4_turbo starts speaking in ~0.16s against ~0.8s for
// eleven_v4 and can be switched to with ELEVENLABS_MODEL, no code change.
const MODEL = process.env.ELEVENLABS_MODEL || "eleven_v4";
const TIMEOUT_MS = 25_000;

// v3 and v4 read bracketed audio tags as performance directions rather than speech. The tags are
// open-ended cues, not a fixed list; these are from the examples ElevenLabs documents for v4, one per
// reply (contrasting tags on the same words blur each other). Where a feeling has no tag the voice's
// own delivery is left alone. Set ELEVENLABS_EMOTION_TAGS=off to drop them entirely.
export const TAGS: Partial<Record<Emotion, string>> = {
  happy: "[excited]",
  sad: "[let down, quietly]",
  angry: "[mad]",
  surprised: "[startled]",
  embarrassed: "[nervous]",
  thinking: "[thoughtful]",
  love: "[softly, content]",
};

// The line before this one in the same reply, sent along so the voice carries on from it instead of
// starting each line cold. Not every model accepts it (v3 and v4 are not documented to), so the first
// refusal turns it off for the rest of the run, and ELEVENLABS_CONTEXT=off never tries.
const MAX_CONTEXT_CHARS = 300;
let contextSupported = process.env.ELEVENLABS_CONTEXT !== "off";

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
  signal: AbortSignal,
  context?: { previousText?: string; cue?: string }
): Promise<AsyncGenerator<Buffer> | null> {
  if (!elevenLabsEnabled()) return null;

  const spoken = toPerformedText(toSpokenText(text));
  if (!spoken) return null;

  // One direction per line: the finer cue from the reply when there is one, else the feeling's own.
  const cue = context?.cue ? cleanCue(context.cue) : null;
  const tag = process.env.ELEVENLABS_EMOTION_TAGS === "off" ? undefined : cue ? `[${cue}]` : TAGS[emotion];
  const previous = context?.previousText ? toPerformedText(toSpokenText(context.previousText)) : "";

  try {
    let res: Response;
    // A reply is voiced a line at a time, several lines at once, which can brush
    // against the plan's concurrent-request limit (429). That clears within a
    // moment, so wait it out rather than losing a line of her voice.
    for (let attempt = 0; ; attempt++) {
      const withContext = contextSupported && previous.length > 0;
      res = await fetch(`${API_URL}/${process.env.ELEVENLABS_VOICE_ID}/stream?output_format=mp3_44100_128`, {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: tag ? `${tag} ${spoken}` : spoken,
          model_id: MODEL,
          ...(withContext ? { previous_text: previous.slice(-MAX_CONTEXT_CHARS) } : {}),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      if (res.status === 429 && attempt < 2) {
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      // The model does not take previous_text: stop sending it and ask again without.
      if (withContext && (res.status === 400 || res.status === 422)) {
        const why = await res.text();
        if (/previous_text|next_text/i.test(why)) {
          contextSupported = false;
          console.warn(`[tts] ${MODEL} does not take previous_text; lines are voiced one by one from now on`);
          continue;
        }
        console.error(`[tts] elevenlabs ${res.status}: ${why.slice(0, 200)}`);
        return null;
      }
      break;
    }

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
