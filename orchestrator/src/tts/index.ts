import type { Emotion } from "../persona.js";
import { synthesizeStream as streamElevenLabs } from "./elevenlabs.js";
import { synthesize as viaTypecast } from "./typecast.js";

// Picking a voice is a matter of taste that has already changed twice, so the
// provider is a setting rather than a code change. Typecast stays the default
// so an unset TTS_PROVIDER behaves exactly as before.
export async function synthesizeStream(
  text: string,
  emotion: Emotion,
  signal: AbortSignal
): Promise<AsyncGenerator<Buffer> | null> {
  if (process.env.TTS_PROVIDER === "elevenlabs") return streamElevenLabs(text, emotion, signal);

  // Typecast's endpoint here isn't streamed: hand over the whole clip as one chunk.
  const audio = await viaTypecast(text, emotion);
  if (!audio || signal.aborted) return null;
  return (async function* () {
    yield audio;
  })();
}
