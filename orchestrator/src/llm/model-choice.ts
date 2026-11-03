import { getSetting, setSetting } from "../memory/settings.js";

// Which Gemini model Shiro uses, switched by the owner with the /model slash command
// (discord/commands.ts). Kept in the settings table so a restart keeps it. Every Gemini text
// call follows it: the conversation, chatter, wonder, guild chat, briefings, learning,
// transcription (unless SHIRO_TRANSCRIBE_MODEL is set) and the rest. The speech check in
// voice (a lite model) and the embeddings are separate and stay as they are.

export const CHAT_MODELS = {
  "3.8": "gemini-3.8-flash",
  "3.0": "gemini-3-flash-preview",
} as const;

export type ChatModelKey = keyof typeof CHAT_MODELS;

const SETTING_KEY = "chatModel";
const DEFAULT_KEY: ChatModelKey = "3.8";

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
