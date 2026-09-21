import type { Emotion } from "../persona.js";
import { broadcast, hasAvatarClient, say } from "./bridge.js";
import { synthesizeStream } from "../tts/index.js";

// The reply currently being voiced. A newer reply supersedes it: its request is
// cancelled (no paying for audio nobody will hear) and the avatar drops any
// chunks still in flight, since they're matched to their "say" by id.
let active: AbortController | null = null;

/**
 * Expression first, voice second. The pose goes out immediately so she reacts
 * the instant the reply exists; the voice then streams in behind it, chunk by
 * chunk, so it starts playing well before the full sentence is synthesized.
 */
export function sayAndSpeak(emotion: Emotion, text: string): void {
  const id = say(emotion, text);

  active?.abort();
  active = null;

  // Nobody is listening — don't pay to synthesize a voice no one will hear.
  if (!hasAvatarClient()) return;

  const controller = new AbortController();
  active = controller;
  void stream(id, emotion, text, controller).finally(() => {
    if (active === controller) active = null;
  });
}

async function stream(id: string, emotion: Emotion, text: string, controller: AbortController): Promise<void> {
  const audio = await synthesizeStream(text, emotion, controller.signal);
  if (!audio || controller.signal.aborted) return;

  broadcast({ type: "speak_start", id, mime: "audio/mpeg" });
  try {
    for await (const chunk of audio) {
      if (controller.signal.aborted) return;
      broadcast({ type: "speak_chunk", id, data: chunk.toString("base64") });
    }
  } catch (err) {
    if (!controller.signal.aborted) console.error("[tts] stream interrupted:", err instanceof Error ? err.message : err);
  }
  // Also on a mid-stream failure: close it so the avatar plays what it has
  // instead of waiting on audio that isn't coming.
  if (!controller.signal.aborted) broadcast({ type: "speak_end", id });
}
