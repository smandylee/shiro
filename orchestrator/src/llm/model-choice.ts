import { getSetting, setSetting } from "../memory/settings.js";

// Which Gemini model the conversation (gemini.ts chat) uses, switched by the owner with the
// /model slash command (discord/commands.ts). Kept in the settings table so a restart keeps
// it. Only the conversation follows it; background calls (chatter, wonder, guild chat, ...)
// keep their own fixed model.

export const CHAT_MODELS = {
  "3.8": "gemini-3.8-flash",
  "3.0": "gemini-3-flash-preview",
} as const;

export type ChatModelKey = keyof typeof CHAT_MODELS;

const SETTING_KEY = "chatModel";
const DEFAULT_KEY: ChatModelKey = "3.0";

export function isChatModelKey(value: unknown): value is ChatModelKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CHAT_MODELS, value);
}

export function chatModelKey(): ChatModelKey {
  const stored = getSetting(SETTING_KEY);
  return isChatModelKey(stored) ? stored : DEFAULT_KEY;
}

export function chatModel(): string {
  return CHAT_MODELS[chatModelKey()];
}

export function setChatModel(key: ChatModelKey): void {
  setSetting(SETTING_KEY, key);
}
