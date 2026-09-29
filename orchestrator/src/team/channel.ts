import { AttachmentBuilder, ChannelType, type Message, type TextChannel, type ThreadChannel, type Webhook } from "discord.js";
import { getDiscordClient } from "../discord/actions.js";
import type { TeamImage, TeamMember } from "./members.js";

// The team channel: one server text channel where the owner hands Shiro work.
// Every request there gets its own thread, and teammates post their results
// into it under their own names through one webhook, so the owner can watch
// who did what. Unset TEAM_CHANNEL_ID and the whole thing stays off.

export const TEAM_CHANNEL_ID = process.env.TEAM_CHANNEL_ID || null;

/** The thread this message belongs to in the team channel, opening one for a new request. Null when it isn't team channel traffic. */
export async function teamThreadFor(message: Message): Promise<ThreadChannel | null> {
  if (!TEAM_CHANNEL_ID) return null;
  const ch = message.channel;
  if (ch.id === TEAM_CHANNEL_ID) {
    return message.startThread({ name: message.content.slice(0, 90) || "새 작업" });
  }
  if (ch.isThread() && ch.parentId === TEAM_CHANNEL_ID) return ch;
  return null;
}

let webhook: Webhook | null = null;

async function getWebhook(): Promise<Webhook> {
  if (webhook) return webhook;
  if (!TEAM_CHANNEL_ID) throw new Error("TEAM_CHANNEL_ID is not set");
  const client = getDiscordClient();
  const channel = await client.channels.fetch(TEAM_CHANNEL_ID);
  if (channel?.type !== ChannelType.GuildText) throw new Error("TEAM_CHANNEL_ID is not a server text channel");
  const text = channel as TextChannel;
  const hooks = await text.fetchWebhooks();
  webhook = hooks.find((h) => h.owner?.id === client.user?.id) ?? (await text.createWebhook({ name: "Shiro Team" }));
  return webhook;
}

// Discord caps a message at 2000 characters; cut on line breaks where possible.
function chunk(text: string, size = 1900): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Posts a teammate's result into the thread under their name. */
export async function postAsMember(threadId: string, member: TeamMember, text: string, images: TeamImage[] = []): Promise<void> {
  const hook = await getWebhook();
  const identity = { username: member.name, avatarURL: member.avatar, threadId };
  const parts = chunk(text);
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const files = last
      ? images.map((img, n) => new AttachmentBuilder(img.data, { name: `${member.id}-${n + 1}.${img.mimeType.split("/")[1] ?? "png"}` }))
      : [];
    await hook.send({ ...identity, content: parts[i], files });
  }
  if (parts.length === 0 && images.length > 0) {
    await hook.send({
      ...identity,
      files: images.map((img, n) => new AttachmentBuilder(img.data, { name: `${member.id}-${n + 1}.png` })),
    });
  }
}
