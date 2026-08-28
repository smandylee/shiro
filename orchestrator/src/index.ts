import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { chat, type MediaPart } from "./llm/gemini.js";
import { parseEmotionTag, EMOTIONS } from "./persona.js";
import { startAvatarBridge, say as avatarSay } from "./avatar/bridge.js";
import { addTurn, getRecentHistory } from "./memory/shortterm.js";
import { remember, recall } from "./memory/longterm.js";
import { getSetting, setSetting } from "./memory/settings.js";
import { checkReminders } from "./reminders.js";
import { setDiscordClient } from "./discord/actions.js";
import { getContact } from "./memory/contacts.js";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  throw new Error("DISCORD_BOT_TOKEN is not set");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const HISTORY_LIMIT = 20;

// Fail closed: without this, every Discord user would be treated as the owner
// and handed the Gmail/Calendar/Drive tools.
const OWNER_USER_ID = process.env.DISCORD_OWNER_USER_ID;
if (!OWNER_USER_ID) {
  throw new Error("DISCORD_OWNER_USER_ID is not set");
}

const channelLocks = new Map<string, Promise<void>>();

function runExclusive(channelId: string, fn: () => Promise<void>): void {
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

type DiscordAttachment = {
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

async function sendAsChatBubbles(channel: { send: (content: string) => Promise<unknown>; sendTyping: () => Promise<unknown> }, text: string) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const bubbles = (lines.length > 0 ? lines : [text]).flatMap(splitToLimit);

  for (const line of bubbles) {
    await channel.sendTyping();
    const typingDelay = Math.min(1000 + line.length * 45, 3500);
    await new Promise((resolve) => setTimeout(resolve, typingDelay));
    await channel.send(line);
  }
}

const REMINDER_CHECK_INTERVAL_MS = 5 * 60 * 1000;

client.once(Events.ClientReady, async (c) => {
  console.log(`logged in as ${c.user.tag}`);
  setDiscordClient(client);
  startAvatarBridge(EMOTIONS);

  const ownerUserId = process.env.DISCORD_OWNER_USER_ID;
  if (ownerUserId) {
    try {
      const owner = await client.users.fetch(ownerUserId);
      const dm = await owner.createDM();
      setSetting("ownerChannelId", dm.id);
      console.log(`[reminders] owner DM channel ready: ${dm.id}`);
    } catch (err) {
      console.error("[reminders] failed to open owner DM channel:", err);
    }
  }

  const getChannel = async (channelId: string) => {
    const channel = await client.channels.fetch(channelId);
    return channel?.isSendable() ? channel : null;
  };

  const runReminderCheck = () => {
    checkReminders(getChannel).catch((err) => {
      console.error("[reminders] check failed:", err);
    });
  };

  runReminderCheck();
  setInterval(runReminderCheck, REMINDER_CHECK_INTERVAL_MS);
});

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return;
  if (message.guild) return;

  const channelId = message.channelId;
  const isOwner = message.author.id === OWNER_USER_ID;

  if (isOwner && getSetting("ownerChannelId") !== channelId) {
    setSetting("ownerChannelId", channelId);
  }

  runExclusive(channelId, async () => {
    const history = getRecentHistory(channelId, HISTORY_LIMIT);

    console.log(`[DM${isOwner ? "" : " guest"}] ${message.author.tag}: ${message.content}`);

    await message.channel.sendTyping();

    const files = await fetchAttachments(message.attachments.values());

    const sections: string[] = [];
    if (message.content) sections.push(message.content);
    sections.push(...files.texts);
    if (files.unsupported.length > 0) {
      sections.push(`(시로가 읽을 수 없는 형식의 파일도 같이 왔어: ${files.unsupported.join(", ")})`);
    }
    if (sections.length === 0 && files.media.length > 0) {
      sections.push("(파일을 보냈어)");
    }

    const text_ = sections.join("\n\n");
    if (!text_ && files.media.length === 0) return;

    // Recall on the typed message only — an entire attached document as the
    // query embeds to something unrelated to what the user actually asked.
    const memories = await recall(message.content || text_);
    const memoryContext = memories.length > 0 ? memories.join("\n") : undefined;
    const contact = getContact(message.author.id);
    const speakerName = isOwner ? "주인님" : (contact?.name ?? message.author.username);

    let result: { text: string; touchedPersonalData: boolean };
    try {
      result = await chat(history, text_, {
        memoryContext,
        sessionKey: `shiro:${channelId}`,
        images: files.media,
        isOwner,
        senderId: message.author.id,
        contactName: contact?.name,
      });
    } catch (err) {
      console.error("gemini chat failed:", err);
      await message.channel.send("(어... 지금 머리가 잘 안 돌아가네. 잠깐 후에 다시 말 걸어줄래?)");
      return;
    }

    const raw = result.text;
    const { emotion, text } = parseEmotionTag(raw);
    console.log(`  -> emotion=${emotion} text=${text}`);

    addTurn(channelId, "user", text_);
    addTurn(channelId, "model", raw);
    if (!result.touchedPersonalData) {
      // Store the emotion-tag-stripped reply — the tag is noise in recall.
      void remember(speakerName, text_, text);
    }

    avatarSay(emotion, text);
    await sendAsChatBubbles(message.channel, text);
  });
});

client.login(token);
