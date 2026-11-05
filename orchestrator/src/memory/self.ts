import { db } from "./db.js";
import { getSetting, setSetting } from "./settings.js";

// What Shiro has come to know about herself from living with the owner: tastes and opinions she
// actually voiced, habits of speech, jokes and nicknames that belong to the two of them, and a short
// diary of the last few days. Like the profile (profile.ts), it is plain sentences that are always in
// front of her, so a better model next year reads the same lines and a wrong one can be found and
// removed. The profile is about the owner; this is about her.
//
// It stays switched off until the owner has read the first draft (the `selfNotesOn` setting, set by
// scripts/self-draft.ts), so deploying the code changes nothing by itself.

db.exec(`
  CREATE TABLE IF NOT EXISTS self_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS self_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    taken_at INTEGER NOT NULL,
    notes_json TEXT NOT NULL
  );
`);

export const NOTE_KINDS = ["taste", "habit", "bond"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export type NoteSource = "learned" | "owner";
export type SelfNote = {
  id: number;
  kind: NoteKind;
  text: string;
  created_at: number;
  updated_at: number;
  source: NoteSource;
};

const KIND_LABEL: Record<NoteKind, string> = {
  taste: "취향과 의견",
  habit: "습관과 말버릇",
  bond: "주인님과 나 사이",
};

export const MAX_NOTES = 30;
export const MAX_NOTE_LENGTH = 120;
export const MAX_DIARY_LENGTH = 400;
const KEEP_SNAPSHOTS = 60;
// The diary is only worth reading while it is recent.
const DIARY_FRESH_MS = 5 * 24 * 3600 * 1000;

const selectAll = db.prepare("SELECT id, kind, text, created_at, updated_at, source FROM self_notes ORDER BY id");
const selectOne = db.prepare("SELECT id, kind, text, created_at, updated_at, source FROM self_notes WHERE id = ?");
const insertNote = db.prepare(
  "INSERT INTO self_notes (kind, text, created_at, updated_at, source) VALUES (?, ?, ?, ?, ?)"
);
const updateNoteStmt = db.prepare("UPDATE self_notes SET text = ?, updated_at = ?, source = ? WHERE id = ?");
const deleteNote = db.prepare("DELETE FROM self_notes WHERE id = ?");
const insertSnapshot = db.prepare("INSERT INTO self_snapshots (taken_at, notes_json) VALUES (?, ?)");
const pruneSnapshots = db.prepare(
  `DELETE FROM self_snapshots WHERE id NOT IN (SELECT id FROM self_snapshots ORDER BY id DESC LIMIT ${KEEP_SNAPSHOTS})`
);

export function isNoteKind(value: unknown): value is NoteKind {
  return typeof value === "string" && (NOTE_KINDS as readonly string[]).includes(value);
}

export function selfNotesOn(): boolean {
  return getSetting("selfNotesOn") === "1";
}

export function setSelfNotesOn(on: boolean): void {
  setSetting("selfNotesOn", on ? "1" : "0");
}

export function listNotes(): SelfNote[] {
  return selectAll.all() as SelfNote[];
}

export function getNote(id: number): SelfNote | null {
  return (selectOne.get(id) as SelfNote | undefined) ?? null;
}

/** One line, no control characters, capped — notes end up inside a prompt. */
export function cleanNote(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_LENGTH);
}

/** Adds a note. Returns its id, or null when it is empty, already there, or the notes are full. */
export function addNote(kind: NoteKind, text: string, source: NoteSource): number | null {
  const clean = cleanNote(text);
  if (!clean || !isNoteKind(kind)) return null;
  const notes = listNotes();
  if (notes.length >= MAX_NOTES) return null;
  if (notes.some((n) => n.text === clean)) return null;
  const now = Date.now();
  return Number(insertNote.run(kind, clean, now, now, source).lastInsertRowid);
}

export function updateNote(id: number, text: string, source: NoteSource): boolean {
  const clean = cleanNote(text);
  if (!clean || !getNote(id)) return false;
  updateNoteStmt.run(clean, Date.now(), source, id);
  return true;
}

export function removeNote(id: number): boolean {
  return deleteNote.run(id).changes > 0;
}

/** Saves the notes (and the diary) as they are now, so a bad rewrite can be undone. */
export function snapshotNotes(): void {
  insertSnapshot.run(Date.now(), JSON.stringify({ notes: listNotes(), diary: getDiary() }));
  pruneSnapshots.run();
}

export function getDiary(): { text: string; at: number } | null {
  const text = getSetting("selfDiary");
  const at = Number(getSetting("selfDiaryAt") ?? 0);
  return text ? { text, at } : null;
}

export function setDiary(text: string, now: number): void {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_DIARY_LENGTH);
  if (!clean) return;
  setSetting("selfDiary", clean);
  setSetting("selfDiaryAt", String(now));
}

function clock(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: process.env.SHIRO_TZ ?? "Asia/Hong_Kong" });
}

/** The notes for a prompt, grouped by kind; "" when there is nothing yet. */
export function renderSelf(now = Date.now()): string {
  const notes = listNotes();
  const diary = getDiary();
  const parts: string[] = [];
  for (const kind of NOTE_KINDS) {
    const lines = notes.filter((n) => n.kind === kind).map((n) => `- ${n.text}`);
    if (lines.length > 0) parts.push(`${KIND_LABEL[kind]}:\n${lines.join("\n")}`);
  }
  if (diary && now - diary.at < DIARY_FRESH_MS) parts.push(`요즘 (${clock(diary.at)} 기준):\n${diary.text}`);
  return parts.join("\n\n");
}

/** The notes for the owner to read and correct: each line with the number they refer to it by. */
export function renderSelfNumbered(): string {
  const notes = listNotes();
  const diary = getDiary();
  const parts: string[] = [];
  for (const kind of NOTE_KINDS) {
    const lines = notes
      .filter((n) => n.kind === kind)
      .map((n) => `${n.id}. ${n.text} (${clock(n.updated_at)}${n.source === "owner" ? ", 주인님이 직접 쓴 것" : ""})`);
    if (lines.length > 0) parts.push(`[${KIND_LABEL[kind]}]\n${lines.join("\n")}`);
  }
  if (diary) parts.push(`[요즘 — ${clock(diary.at)} 일기]\n${diary.text}`);
  return parts.join("\n\n");
}
