import type { Client } from "discord.js";

let client: Client | null = null;

export function setDiscordClient(c: Client): void {
  client = c;
}

export async function sendDirectMessage(userId: string, text: string): Promise<string> {
  if (!client) throw new Error("discord client not initialized");

  const user = await client.users.fetch(userId);
  const dm = await user.createDM();
  await dm.send(text);
  return `${user.tag}(${userId})한테 메시지 보냈어.`;
}

export async function notifyOwner(text: string): Promise<string> {
  const ownerUserId = process.env.DISCORD_OWNER_USER_ID;
  if (!ownerUserId) throw new Error("DISCORD_OWNER_USER_ID is not set");
  return sendDirectMessage(ownerUserId, text);
}
