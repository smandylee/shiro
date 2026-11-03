import { db } from "./db.js";

// Things Shiro has become curious about — from what the owner said, from
// gaps in what she knows about them, or just on her own (see wonder.ts) —
// waiting for a natural moment to ask.
// They pile up here after conversations and are asked (or dropped) later.
//
// Whether a question can be asked at all is settled once, when it is noted: not before the
// thing has happened (ask_after), not once it has gone stale (expires_at). Asking used to
// re-judge the whole list every twenty minutes, and most of those calls only found again
// that a question was stale or too early — two thirds of her model bill.

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
// Added later: older databases get the columns, empty (= askable now, stale after a week).
const columns = (db.prepare("PRAGMA table_info(curiosities)").all() as { name: string }[]).map((c) => c.name);
if (!columns.includes("ask_after")) db.exec("ALTER TABLE curiosities ADD COLUMN ask_after INTEGER");
if (!columns.includes("expires_at")) db.exec("ALTER TABLE curiosities ADD COLUMN expires_at INTEGER");

export type CuriositySource = "conversation" | "profile" | "spontaneous";
export type Curiosity = {
  id: number;
  text: string;
  source: CuriositySource;
  created_at: number;
  ask_after: number | null;
  expires_at: number | null;
};

const MAX_OPEN = 12;
const MAX_LENGTH = 160;
// A question about a week-old remark has usually gone stale; also the longest a question stays
// askable once it may be asked.
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

const selectOpen = db.prepare(
  "SELECT id, text, source, created_at, ask_after, expires_at FROM curiosities WHERE status = 'open' ORDER BY id"
);
const selectRecentAsked = db.prepare(
  "SELECT text FROM curiosities WHERE status = 'asked' ORDER BY asked_at DESC LIMIT ?"
);
const insertOne = db.prepare(
  "INSERT INTO curiosities (text, source, created_at, ask_after, expires_at) VALUES (?, ?, ?, ?, ?)"
);
const markStmt = db.prepare("UPDATE curiosities SET status = ?, asked_at = ? WHERE id = ? AND status = 'open'");
const dropStale = db.prepare(
  `UPDATE curiosities SET status = 'dropped'
   WHERE status = 'open' AND ((expires_at IS NULL AND created_at < ?) OR expires_at < ?)`
);
const dropOldest = db.prepare(
  `UPDATE curiosities SET status = 'dropped' WHERE status = 'open' AND id NOT IN (
     SELECT id FROM curiosities WHERE status = 'open' ORDER BY id DESC LIMIT ${MAX_OPEN}
   )`
);

export function openCuriosities(now = Date.now()): Curiosity[] {
  dropStale.run(now - STALE_MS, now);
  return selectOpen.all() as Curiosity[];
}

/** The open ones that may be asked now, newest first: a fresher question is the more natural one. */
export function askableCuriosities(now = Date.now()): Curiosity[] {
  return openCuriosities(now)
    .filter((c) => c.ask_after === null || c.ask_after <= now)
    .reverse();
}

export function recentlyAsked(limit = 15): string[] {
  return (selectRecentAsked.all(limit) as { text: string }[]).map((r) => r.text);
}

/**
 * Returns false when it is empty or already waiting (or was asked lately).
 * `askAfter`: not before this moment. `expiresAt`: not after it (at most a week after it becomes askable).
 */
export function addCuriosity(
  text: string,
  source: CuriositySource,
  when: { askAfter?: number | null; expiresAt?: number | null } = {}
): boolean {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LENGTH);
  if (!clean) return false;
  if (openCuriosities().some((c) => c.text === clean) || recentlyAsked().includes(clean)) return false;
  const now = Date.now();
  const askAfter = when.askAfter != null && when.askAfter > now ? when.askAfter : null;
  // Every question gets an expiry, so one waiting for a far-off event is not dropped as old meanwhile.
  const expiresAt = Math.min(when.expiresAt ?? Infinity, (askAfter ?? now) + STALE_MS);
  // Already over before it can be asked: nothing to keep.
  if (expiresAt <= (askAfter ?? now)) return false;
  insertOne.run(clean, source, now, askAfter, expiresAt);
  dropOldest.run();
  return true;
}

export function markAsked(id: number): void {
  markStmt.run("asked", Date.now(), id);
}

/** It no longer makes sense to ask (already answered, or moot). */
export function markDropped(id: number): void {
  markStmt.run("dropped", Date.now(), id);
}
