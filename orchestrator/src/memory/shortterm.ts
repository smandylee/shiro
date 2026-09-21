import { db } from "./db.js";
import type { ChatTurn } from "../llm/gemini.js";

const insertTurn = db.prepare(
  "INSERT INTO turns (channel_id, role, text, created_at) VALUES (?, ?, ?, ?)"
);

const selectRecent = db.prepare(
  "SELECT role, text FROM turns WHERE channel_id = ? ORDER BY id DESC LIMIT ?"
);

// Only the most recent turns are ever read back (HISTORY_LIMIT is 20), so keep
// a generous buffer per channel and drop the rest instead of growing forever.
const KEEP_PER_CHANNEL = 200;
const pruneChannel = db.prepare(
  `DELETE FROM turns WHERE channel_id = ? AND id NOT IN (
     SELECT id FROM turns WHERE channel_id = ? ORDER BY id DESC LIMIT ${KEEP_PER_CHANNEL}
   )`
);

export function addTurn(channelId: string, role: "user" | "model", text: string): void {
  insertTurn.run(channelId, role, text, Date.now());
  pruneChannel.run(channelId, channelId);
}

const selectLast = db.prepare(
  "SELECT role, text, created_at FROM turns WHERE channel_id = ? ORDER BY id DESC LIMIT 1"
);

/** The newest turn in a channel, with when it was said — null for a fresh channel. */
export function getLastTurn(channelId: string): { role: "user" | "model"; text: string; at: number } | null {
  const row = selectLast.get(channelId) as { role: "user" | "model"; text: string; created_at: number } | undefined;
  return row ? { role: row.role, text: row.text, at: row.created_at } : null;
}

const selectRecentTimed = db.prepare(
  "SELECT role, text, created_at FROM turns WHERE channel_id = ? ORDER BY id DESC LIMIT ?"
);

/** Like getRecentHistory, with when each turn was said (epoch ms), oldest first. */
export function getRecentTurnsWithTime(
  channelId: string,
  limit: number
): { role: "user" | "model"; text: string; at: number }[] {
  const rows = selectRecentTimed.all(channelId, limit) as { role: "user" | "model"; text: string; created_at: number }[];
  return rows.reverse().map((r) => ({ role: r.role, text: r.text, at: r.created_at }));
}

const selectAfter = db.prepare(
  "SELECT id, role, text, created_at FROM turns WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT ?"
);

/** Turns newer than `afterId`, oldest first — for reading only what is new since last time. */
export function getTurnsAfter(
  channelId: string,
  afterId: number,
  limit: number
): { id: number; role: "user" | "model"; text: string; at: number }[] {
  const rows = selectAfter.all(channelId, afterId, limit) as {
    id: number;
    role: "user" | "model";
    text: string;
    created_at: number;
  }[];
  return rows.map((r) => ({ id: r.id, role: r.role, text: r.text, at: r.created_at }));
}

/** The owner's side of a turn in which Shiro started the conversation with a question. */
export const ASKED = "(시로가 먼저 질문했어)";
// Stand-ins the system writes for turns Shiro opened (a question, a briefing, a
// game remark): not something the owner said.
const SYSTEM_NOTE = /^\((시로가|게임을 구경)/;

/**
 * Whether the last question Shiro asked on her own is still waiting for the
 * owner. Looks back from the newest turn: an ASKED marker reached before any
 * real message from the owner means they haven't answered. Briefings and
 * remarks made in between don't count as an answer, and don't hide the question.
 */
export function hasUnansweredQuestion(channelId: string): boolean {
  const recent = getRecentHistory(channelId, 40);
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = recent[i];
    if (t.role !== "user") continue;
    if (t.text === ASKED) return true;
    if (!SYSTEM_NOTE.test(t.text)) return false;
  }
  return false;
}

export function getRecentHistory(channelId: string, limit: number): ChatTurn[] {
  const rows = selectRecent.all(channelId, limit) as { role: "user" | "model"; text: string }[];
  return rows.reverse();
}
