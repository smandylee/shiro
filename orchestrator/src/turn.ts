import { chat, type MediaPart } from "./llm/gemini.js";
import { parseEmotionTag } from "./persona.js";
import { StreamedReply } from "./reply.js";
import { addTurn, getRecentHistory } from "./memory/shortterm.js";
import { remember, recall } from "./memory/longterm.js";
import { getContact } from "./memory/contacts.js";
import type { VoiceAudio } from "./avatar/bridge.js";

// One exchange: something the owner (or a guest) said, and Shiro's answer to
// it. Typed Discord messages and words spoken to the avatar both arrive here,
// so they get the same memory, tools, streamed reply and voice.

const HISTORY_LIMIT = 20;

const channelLocks = new Map<string, Promise<void>>();

/** Runs tasks for one channel one at a time, so two messages never interleave their replies. */
export function runExclusive(channelId: string, fn: () => Promise<void>): void {
  const prev = channelLocks.get(channelId) ?? Promise.resolve();
  const next: Promise<void> = prev
    .then(fn, fn)
    .catch((err) => {
      console.error("unhandled error in exclusive task:", err);
    })
    .then(() => {
      // Drop the entry once this channel goes idle, so the map doesn't keep
      // one promise per channel Shiro has ever talked in.
      if (channelLocks.get(channelId) === next) channelLocks.delete(channelId);
    });
  channelLocks.set(channelId, next);
}

export type TurnChannel = {
  send: (content: string) => Promise<unknown>;
  sendTyping: () => Promise<unknown>;
};

export type DiscordAttachment = {
  url: string;
  contentType?: string | null;
  name?: string | null;
  size?: number;
};

type FetchedAttachments = {
  // Sent to Gemini as inlineData — images and PDFs are both handled natively.
  media: MediaPart[];
  // Plain-text files are cheaper and more reliable inlined as text.
  texts: string[];
  // Formats Gemini can't read, so the user gets told instead of silent failure.
  unsupported: string[];
};

const MAX_INLINE_BYTES = 15 * 1024 * 1024;
const TEXT_FILE_RE = /\.(txt|md|markdown|csv|tsv|json|ya?ml|log|ics|srt)$/i;
const MAX_TEXT_FILE_CHARS = 20000;

function isInlineMedia(mime: string): boolean {
  return mime.startsWith("image/") || mime === "application/pdf";
}

async function fetchAttachments(attachments: Iterable<DiscordAttachment>): Promise<FetchedAttachments> {
  const out: FetchedAttachments = { media: [], texts: [], unsupported: [] };

  for (const att of attachments) {
    const name = att.name ?? "(이름 없는 파일)";
    const mime = (att.contentType ?? "").split(";")[0].trim();

    if (att.size && att.size > MAX_INLINE_BYTES) {
      out.unsupported.push(`${name} (너무 큼)`);
      continue;
    }

    const isText = mime.startsWith("text/") || TEXT_FILE_RE.test(name);
    if (!isInlineMedia(mime) && !isText) {
      out.unsupported.push(`${name}${mime ? ` (${mime})` : ""}`);
      continue;
    }

    try {
      const res = await fetch(att.url);
      if (!res.ok) {
        out.unsupported.push(`${name} (다운로드 실패)`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());

      if (isInlineMedia(mime)) {
        out.media.push({ mimeType: mime, data: buf.toString("base64") });
      } else {
        const body = buf.toString("utf-8");
        const clipped =
          body.length > MAX_TEXT_FILE_CHARS
            ? `${body.slice(0, MAX_TEXT_FILE_CHARS)}\n...(파일이 길어서 여기까지)`
            : body;
        out.texts.push(`[첨부파일: ${name}]\n${clipped}`);
      }
    } catch (err) {
      console.error(`failed to fetch attachment ${name}:`, err);
      out.unsupported.push(`${name} (읽기 실패)`);
    }
  }

  return out;
}

// Discord rejects any single message over 2000 characters, which would
// otherwise throw and leave the user with no reply at all.
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

function splitToLimit(line: string): string[] {
  if (line.length <= DISCORD_MAX_MESSAGE_LENGTH) return [line];
  const parts: string[] = [];
  for (let i = 0; i < line.length; i += DISCORD_MAX_MESSAGE_LENGTH) {
    parts.push(line.slice(i, i + DISCORD_MAX_MESSAGE_LENGTH));
  }
  return parts;
}

async function sendAsChatBubbles(channel: TurnChannel, text: string) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const bubbles = (lines.length > 0 ? lines : [text]).flatMap(splitToLimit);

  for (const line of bubbles) {
    await channel.sendTyping();
    // Just enough "typing" to feel like a person; replies are short now, and
    // every extra second here is a second the owner waits after she has answered.
    const typingDelay = Math.min(600 + line.length * 30, 2200);
    await new Promise((resolve) => setTimeout(resolve, typingDelay));
    await channel.send(line);
  }
}

/**
 * Something the owner said out loud. The model is given the audio itself, so it
 * can start answering at once; these say whether it may be shown (a person really
 * was speaking) and what the words were (for the history and her memory).
 */
export type VoiceInput = {
  audio: VoiceAudio;
  speech: Promise<boolean>;
  transcript: Promise<string>;
};

// What the model is told alongside the audio (the stored history keeps the words instead).
const VOICE_PLACEHOLDER =
  "(주인님이 음성으로 말했어. 첨부된 오디오가 주인님이 방금 한 말이야. 오디오에서 실제로 들리는 말에만 답하고, 들리지 않는 말을 지어내지 않는다.)";

export type TurnInput = {
  /** Spoken to the avatar: `content` and `attachments` are unused, the audio is the message. */
  voice?: VoiceInput;
  channel: TurnChannel;
  channelId: string;
  isOwner: boolean;
  authorId: string;
  /** Shown in logs, and what a guest is called when Shiro hasn't been told their name. */
  authorName: string;
  content: string;
  attachments: Iterable<DiscordAttachment>;
  /** How it arrived, for the log only. */
  via?: "text" | "voice";
};

export async function runTurn(input: TurnInput): Promise<void> {
  const { channel, channelId, isOwner, authorId, authorName, content } = input;
  const history = getRecentHistory(channelId, HISTORY_LIMIT);

  console.log(`[DM${isOwner ? "" : " guest"}${input.via === "voice" ? " voice" : ""}] ${authorName}: ${content}`);

  // Per-stage timing, logged once per reply — replies were taking 15-20s and
  // the model call alone measures ~2s, so the time is going somewhere else.
  const t0 = Date.now();
  // The "typing…" indicator is decoration: nothing waits for it.
  channel.sendTyping().catch(() => {});
  const tTyping = Date.now();

  const voice = input.voice;
  const files: FetchedAttachments = voice
    ? { media: [{ mimeType: voice.audio.mime, data: voice.audio.data }], texts: [], unsupported: [] }
    : await fetchAttachments(input.attachments);
  const tFiles = Date.now();

  const sections: string[] = [];
  if (content) sections.push(content);
  sections.push(...files.texts);
  if (files.unsupported.length > 0) {
    sections.push(`(시로가 읽을 수 없는 형식의 파일도 같이 왔어: ${files.unsupported.join(", ")})`);
  }
  if (sections.length === 0 && files.media.length > 0) {
    sections.push("(파일을 보냈어)");
  }

  const text_ = voice ? VOICE_PLACEHOLDER : sections.join("\n\n");
  if (!text_ && files.media.length === 0) return;

  // Recall on the typed message only — an entire attached document as the
  // query embeds to something unrelated to what the user actually asked.
  // Spoken messages skip it: the words aren't written out yet, and waiting for
  // them is exactly the delay being avoided. (Her profile and the recent chat still apply.)
  const memories = voice ? [] : await recall(content || text_);
  const tRecall = Date.now();
  const memoryContext = memories.length > 0 ? memories.join("\n") : undefined;
  const contact = getContact(authorId);
  const speakerName = isOwner ? "주인님" : (contact?.name ?? authorName);

  // The reply is shown and voiced as the model writes it: her expression the
  // moment the emotion tag is complete, then each line as a bubble and in her
  // voice as soon as it is finished, instead of after the whole answer.
  const reply = new StreamedReply((line) => sendAsChatBubbles(channel, line));
  // Nothing she says to spoken words is shown until a person is confirmed to have spoken.
  if (voice) reply.hold(voice.speech);

  let result: { text: string; touchedPersonalData: boolean };
  try {
    result = await chat(history, text_, {
      memoryContext,
      sessionKey: `shiro:${channelId}`,
      images: files.media,
      isOwner,
      senderId: authorId,
      contactName: contact?.name,
      viaVoice: Boolean(voice),
      toolGate: voice?.speech,
      onText: (delta) => reply.push(delta),
    });
  } catch (err) {
    console.error("gemini chat failed:", err);
    // Lines already on their way finish first, so the apology comes after them.
    await reply.abort();
    await channel.send("(어... 지금 머리가 잘 안 돌아가네. 잠깐 후에 다시 말 걸어줄래?)");
    return;
  }

  const tChat = Date.now();
  await reply.finish();
  const ms = (v: number | null) => (v === null ? "-" : `${v}ms`);
  console.log(
    `  -> timing: typing=${tTyping - t0}ms attach=${tFiles - tTyping}ms recall=${tRecall - tFiles}ms chat=${tChat - tRecall}ms ` +
      `(pose ${ms(reply.timings.pose)}, first line ${ms(reply.timings.firstLine)} after the model started) total=${Date.now() - t0}ms`
  );

  // What goes in the history and her memory is what was said, not the stand-in
  // the model was given for the audio.
  let said = text_;
  if (voice) {
    if (reply.wasDiscarded) {
      console.log("  -> not speech: the answer was thrown away");
      return;
    }
    said = await voice.transcript;
    if (!said) {
      console.log("  -> nothing written out: the exchange is not kept");
      return;
    }
  }

  const raw = result.text;
  const { emotion, text } = parseEmotionTag(raw);
  console.log(`  -> emotion=${emotion} text=${text}`);

  addTurn(channelId, "user", said);
  addTurn(channelId, "model", raw);
  if (!result.touchedPersonalData) {
    // Store the emotion-tag-stripped reply — the tag is noise in recall.
    void remember(speakerName, said, text);
  }
}
