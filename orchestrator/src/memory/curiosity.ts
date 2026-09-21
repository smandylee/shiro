import { db } from "./db.js";

// Things Shiro has become curious about — from what the owner said, or from
// gaps in what she knows about them — waiting for a natural moment to ask.
// They pile up here after conversations and are asked (or dropped) later.

db.exec(`
  CREATE TABLE IF NOT EXISTS curiosities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    asked_at INTEGER
  );
`);

export type CuriositySource = "conversation" | "profile";
export type Curiosity = { id: number; text: string; source: CuriositySource; created_at: number };

const MAX_OPEN = 12;
const MAX_LENGTH = 160;
// A question about a week-old remark has usually gone stale.
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

const selectOpen = db.prepare("SELECT id, text, source, created_at FROM curiosities WHERE status = 'open' ORDER BY id");
const selectRecentAsked = db.prepare(
  "SELECT text FROM curiosities WHERE status = 'asked' ORDER BY asked_at DESC LIMIT ?"
);
const insertOne = db.prepare("INSERT INTO curiosities (text, source, created_at) VALUES (?, ?, ?)");
const markStmt = db.prepare("UPDATE curiosities SET status = ?, asked_at = ? WHERE id = ? AND status = 'open'");
const dropStale = db.prepare("UPDATE curiosities SET status = 'dropped' WHERE status = 'open' AND created_at < ?");
const dropOldest = db.prepare(
  `UPDATE curiosities SET status = 'dropped' WHERE status = 'open' AND id NOT IN (
     SELECT id FROM curiosities WHERE status = 'open' ORDER BY id DESC LIMIT ${MAX_OPEN}
   )`
);

export function openCuriosities(): Curiosity[] {
  dropStale.run(Date.now() - STALE_MS);
  return selectOpen.all() as Curiosity[];
}

export function recentlyAsked(limit = 15): string[] {
  return (selectRecentAsked.all(limit) as { text: string }[]).map((r) => r.text);
}

/** Returns false when it is empty or already waiting (or was asked lately). */
export function addCuriosity(text: string, source: CuriositySource): boolean {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LENGTH);
  if (!clean) return false;
  if (openCuriosities().some((c) => c.text === clean) || recentlyAsked().includes(clean)) return false;
  insertOne.run(clean, source, Date.now());
  dropOldest.run();
  return true;
}

export function markAsked(id: number): void {
  markStmt.run("asked", Date.now(), id);
}
