import type { Emotion } from "../persona.js";

// Speech is a garnish on the Discord reply, never a dependency of it: every
// failure here is logged and swallowed so a TTS outage can't cost her a message.

const API_URL = "https://api.typecast.ai/v1/text-to-speech";
const MODEL = "ssfm-v30";
const TIMEOUT_MS = 20_000;

// The API takes up to 2000 characters, but a long monologue read aloud is a
// chore; cut at a sentence boundary well before that.
const MAX_SPOKEN_CHARS = 400;

// Shiro's eight emotions onto the presets ssfm-v30 offers (normal, happy, sad,
// angry, whisper, toneup, tonedown). Whisper stands in for embarrassed — the
// closest thing to a shy, quiet voice.
const PRESETS: Record<Emotion, { preset: string; intensity: number }> = {
  neutral: { preset: "normal", intensity: 1 },
  happy: { preset: "happy", intensity: 1.2 },
  sad: { preset: "sad", intensity: 1 },
  angry: { preset: "angry", intensity: 0.9 },
  surprised: { preset: "toneup", intensity: 1.3 },
  embarrassed: { preset: "whisper", intensity: 0.8 },
  thinking: { preset: "tonedown", intensity: 0.8 },
  love: { preset: "happy", intensity: 1.5 },
};

let warnedMissingKey = false;

export function ttsEnabled(): boolean {
  const ready = Boolean(process.env.TYPECAST_API_KEY && process.env.TYPECAST_VOICE_ID);
  if (!ready && !warnedMissingKey) {
    warnedMissingKey = true;
    console.warn("[tts] TYPECAST_API_KEY / TYPECAST_VOICE_ID not set — voice disabled");
  }
  return ready;
}

/** Text as it should be *heard*: no emoji, no markdown, one breath-separated run. */
export function toSpokenText(text: string): string {
  const flat = text
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/[*_`~#>]/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (flat.length <= MAX_SPOKEN_CHARS) return flat;

  const head = flat.slice(0, MAX_SPOKEN_CHARS);
  const lastStop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return lastStop > MAX_SPOKEN_CHARS / 2 ? head.slice(0, lastStop + 1) : head;
}

/** Returns MP3 bytes, or null when voice is off, the text is empty, or the call failed. */
export async function synthesize(text: string, emotion: Emotion): Promise<Buffer | null> {
  if (!ttsEnabled()) return null;

  const spoken = toSpokenText(text);
  if (!spoken) return null;

  const { preset, intensity } = PRESETS[emotion] ?? PRESETS.neutral;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.TYPECAST_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        voice_id: process.env.TYPECAST_VOICE_ID,
        model: MODEL,
        language: "kor",
        text: spoken,
        prompt: { emotion_type: "preset", emotion_preset: preset, emotion_intensity: intensity },
        output: { audio_format: "mp3" },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const hint = res.status === 402 ? " (out of credits)" : res.status === 401 || res.status === 403 ? " (check API key)" : "";
      console.error(`[tts] typecast ${res.status}${hint}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }

    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error("[tts] synthesis failed:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
