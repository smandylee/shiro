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

export function getRecentHistory(channelId: string, limit: number): ChatTurn[] {
  const rows = selectRecent.all(channelId, limit) as { role: "user" | "model"; text: string }[];
  return rows.reverse();
}
