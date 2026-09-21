import type { Emotion } from "../persona.js";
import { broadcast, hasAvatarClient, say, type AvatarEvent } from "./bridge.js";
import { synthesizeStream } from "../tts/index.js";

// A reply is voiced a line at a time. Every line starts synthesizing the moment
// it exists — while the model is still writing the next one — but the audio goes
// to the avatar strictly in line order, so a short line that finishes early
// never jumps ahead of a longer one before it.

// Plans cap concurrent synthesis requests, and a line rarely needs to be ready
// long before the one ahead of it has finished playing.
const MAX_PARALLEL = 2;

export type VoiceDeps = {
  synth: typeof synthesizeStream;
  send: (event: AvatarEvent) => void;
};

const defaultDeps: VoiceDeps = { synth: synthesizeStream, send: broadcast };

type Slot = { chunks: Buffer[]; done: boolean };

/** Wakes whoever is waiting for "something changed" — a chunk, a finished line, a new line. */
class Signal {
  private resolve: (() => void) | null = null;
  private pending = false;

  notify(): void {
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r();
    } else {
      this.pending = true;
    }
  }

  wait(): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((r) => (this.resolve = r));
  }
}

export class ReplyVoice {
  readonly id: string;
  private readonly controller = new AbortController();
  private readonly slots: Slot[] = [];
  private readonly changed = new Signal();
  private readonly sender: Promise<void>;
  private closed = false;
  private started = false;
  private running = 0;
  private waiting: (() => void)[] = [];
  private caption = "";

  constructor(
    id: string,
    private readonly emotion: Emotion,
    private readonly deps: VoiceDeps = defaultDeps,
    private readonly onFirstAudio?: () => void
  ) {
    this.id = id;
    this.sender = this.send();
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  /** Text shown alongside the voice (the avatar's speech bubble): everything said so far. */
  setCaption(text: string): void {
    if (text === this.caption || this.aborted) return;
    this.caption = text;
    this.deps.send({ type: "caption", id: this.id, text });
  }

  /** Start voicing a line now. Lines play in the order they were added. */
  addLine(line: string): void {
    if (this.aborted || this.closed) return;
    const slot: Slot = { chunks: [], done: false };
    this.slots.push(slot);
    this.changed.notify();
    void this.fill(slot, line);
  }

  /** No more lines are coming. Resolves once everything has been sent. */
  end(): Promise<void> {
    this.closed = true;
    this.changed.notify();
    return this.sender;
  }

  /** A newer reply supersedes this one: stop asking for audio nobody will hear. */
  abort(): void {
    this.controller.abort();
    this.changed.notify();
  }

  private async acquire(): Promise<void> {
    if (this.running < MAX_PARALLEL) {
      this.running++;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next(); // hand the slot straight to the next line in the queue
    else this.running--;
  }

  private async fill(slot: Slot, line: string): Promise<void> {
    await this.acquire();
    try {
      if (this.aborted) return;
      const audio = await this.deps.synth(line, this.emotion, this.controller.signal);
      if (!audio) return;
      for await (const chunk of audio) {
        if (this.aborted) return;
        slot.chunks.push(chunk);
        this.changed.notify();
      }
    } catch (err) {
      if (!this.aborted) console.error("[tts] stream interrupted:", err instanceof Error ? err.message : err);
    } finally {
      slot.done = true;
      this.release();
      this.changed.notify();
    }
  }

  private async send(): Promise<void> {
    for (let i = 0; ; ) {
      if (this.aborted) return;
      const slot = this.slots[i];
      if (!slot) {
        if (this.closed) break;
        await this.changed.wait();
        continue;
      }
      // Drain this line before moving to the next; the next line's audio is
      // already being collected in the background.
      for (;;) {
        if (this.aborted) return;
        const chunk = slot.chunks.shift();
        if (chunk) {
          this.emit(chunk);
          continue;
        }
        if (slot.done) break;
        await this.changed.wait();
      }
      i++;
    }

    // Closes a reply that has at least some audio, including one cut short by a
    // failure, so the avatar plays what it has instead of waiting for the rest.
    if (this.started && !this.aborted) this.deps.send({ type: "speak_end", id: this.id });
  }

  private emit(chunk: Buffer): void {
    if (!this.started) {
      this.started = true;
      this.deps.send({ type: "speak_start", id: this.id, mime: "audio/mpeg" });
      this.onFirstAudio?.();
    }
    this.deps.send({ type: "speak_chunk", id: this.id, data: chunk.toString("base64") });
  }
}

// The reply currently being voiced. A newer one supersedes it.
let active: ReplyVoice | null = null;

/**
 * Starts a reply: the pose goes out immediately, so she reacts the instant the
 * emotion is known, and the returned voice is then fed lines as they are written.
 * Returns null when nobody is listening — no point paying to synthesize a voice
 * no one will hear.
 */
export function startReply(emotion: Emotion, initialText = "", onFirstAudio?: () => void): ReplyVoice | null {
  const id = say(emotion, initialText);

  active?.abort();
  active = null;
  if (!hasAvatarClient()) return null;

  active = new ReplyVoice(id, emotion, defaultDeps, onFirstAudio);
  return active;
}

/** The owner started talking over her: stop asking for audio nobody should hear now. */
export function interruptSpeech(): void {
  active?.abort();
  active = null;
}

/** A finished message (reminders, briefings): voiced line by line like a streamed reply. */
export function sayAndSpeak(emotion: Emotion, text: string): void {
  const voice = startReply(emotion, text);
  if (!voice) return;
  for (const line of text.split("\n")) if (line.trim()) voice.addLine(line.trim());
  void voice.end();
}
