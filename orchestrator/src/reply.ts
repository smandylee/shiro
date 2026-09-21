import { parseEmotionTag } from "./persona.js";
import { startReply, type ReplyVoice } from "./avatar/speak.js";

// Turns the model's text, as it arrives in pieces, into what the owner sees and
// hears: her expression the instant the emotion tag is complete, then each line
// as a Discord bubble and in her voice the moment it is finished — instead of
// waiting for the whole reply.

const TAG_RE = /^\s*\[emotion:([a-z]+)\]\s*/i;
const ANY_TAG_RE = /\[emotion:[a-z]+\]\s*/gi;
// A tag is short. Past this, an opening "[" is just text.
const MAX_TAG_LENGTH = 30;

export class StreamedReply {
  private buffer = "";
  private voice: ReplyVoice | null = null;
  private started = false;
  private text = "";
  private bubbles: Promise<void> = Promise.resolve();
  private readonly t0 = Date.now();

  /** Milliseconds from creation to each stage, for spotting where a reply spends its time. */
  readonly timings: { pose: number | null; firstLine: number | null; firstAudio: number | null } = {
    pose: null,
    firstLine: null,
    firstAudio: null,
  };

  /** `sendLine` posts one line to the owner's chat (the typing pause is its business). */
  constructor(private readonly sendLine: (line: string) => Promise<void>) {}

  push(delta: string): void {
    this.buffer += delta;
    this.drain(false);
  }

  /** The model is done: flush the last line, and wait for the chat bubbles (not the audio). */
  async finish(): Promise<void> {
    this.drain(true);
    await this.bubbles;
    // The voice keeps streaming after this; the chat doesn't wait on it.
    void this.voice?.end();
  }

  /**
   * The reply failed part-way: stop asking for audio for it. Resolves once the
   * lines already on their way have been posted, so whatever is said next
   * (an apology, say) lands after them rather than in front.
   */
  abort(): Promise<void> {
    this.voice?.abort();
    return this.bubbles;
  }

  private begin(final: boolean): boolean {
    if (this.started) return true;

    const head = this.buffer.trimStart();
    if (!head) return false;

    const tag = this.buffer.match(TAG_RE);
    if (tag) {
      this.buffer = this.buffer.slice(tag[0].length);
      this.start(parseEmotionTag(tag[0]).emotion);
      return true;
    }
    // "[emotion:ha" may still turn into a tag — hold on, unless it has run on
    // too long to be one.
    if (!final && head.startsWith("[") && !head.includes("]") && head.length < MAX_TAG_LENGTH) return false;

    this.start("neutral");
    return true;
  }

  private start(emotion: Parameters<typeof startReply>[0]): void {
    this.started = true;
    this.timings.pose = Date.now() - this.t0;
    this.voice = startReply(emotion, "", () => {
      this.timings.firstAudio = Date.now() - this.t0;
      console.log(`  -> voice: first audio ${this.timings.firstAudio}ms after the model started`);
    });
  }

  private drain(final: boolean): void {
    if (!this.begin(final)) return;

    for (let nl = this.buffer.indexOf("\n"); nl !== -1; nl = this.buffer.indexOf("\n")) {
      this.emit(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
    }
    if (final) {
      this.emit(this.buffer);
      this.buffer = "";
    }
  }

  private emit(raw: string): void {
    // Only the opening tag sets her expression; one that turns up later (a reply
    // that resumed after a tool call) is dropped rather than shown.
    const line = raw.replace(ANY_TAG_RE, "").trim();
    if (!line) return;

    this.text = this.text ? `${this.text}\n${line}` : line;
    this.timings.firstLine ??= Date.now() - this.t0;

    this.voice?.setCaption(this.text);
    this.voice?.addLine(line);
    this.bubbles = this.bubbles
      .then(() => this.sendLine(line))
      .catch((err) => console.error("[reply] failed to send a line:", err));
  }
}
