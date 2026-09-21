import { db } from "./db.js";

// What Shiro knows about the owner as plain sentences — tastes, what they're
// working on, how they like to be spoken to. Unlike long-term recall (which
// finds old conversations by similarity, and only when something similar comes
// up), the profile is always in front of her. It is text on purpose: a better
// model next year reads the same sentences, and any wrong one can be found and
// removed.

db.exec(`
  CREATE TABLE IF NOT EXISTS profile_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profile_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    taken_at INTEGER NOT NULL,
    facts_json TEXT NOT NULL
  );
`);

export type FactSource = "learned" | "owner";
export type ProfileFact = { id: number; text: string; created_at: number; updated_at: number; source: FactSource };

export const MAX_FACTS = 80;
export const MAX_FACT_LENGTH = 200;
const KEEP_SNAPSHOTS = 60;

const selectAll = db.prepare("SELECT id, text, created_at, updated_at, source FROM profile_facts ORDER BY id");
const selectOne = db.prepare("SELECT id, text, created_at, updated_at, source FROM profile_facts WHERE id = ?");
const insertFact = db.prepare("INSERT INTO profile_facts (text, created_at, updated_at, source) VALUES (?, ?, ?, ?)");
const updateFactStmt = db.prepare("UPDATE profile_facts SET text = ?, updated_at = ?, source = ? WHERE id = ?");
const deleteFact = db.prepare("DELETE FROM profile_facts WHERE id = ?");
const insertSnapshot = db.prepare("INSERT INTO profile_snapshots (taken_at, facts_json) VALUES (?, ?)");
const pruneSnapshots = db.prepare(
  `DELETE FROM profile_snapshots WHERE id NOT IN (SELECT id FROM profile_snapshots ORDER BY id DESC LIMIT ${KEEP_SNAPSHOTS})`
);

export function listFacts(): ProfileFact[] {
  return selectAll.all() as ProfileFact[];
}

export function getFact(id: number): ProfileFact | null {
  return (selectOne.get(id) as ProfileFact | undefined) ?? null;
}

/** One line, no control characters, capped — facts end up inside a prompt. */
export function cleanFact(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_FACT_LENGTH);
}

/** Adds a fact. Returns its id, or null when it is empty, already known, or the profile is full. */
export function addFact(text: string, source: FactSource): number | null {
  const clean = cleanFact(text);
  if (!clean) return null;
  const facts = listFacts();
  if (facts.length >= MAX_FACTS) return null;
  if (facts.some((f) => f.text === clean)) return null;
  const now = Date.now();
  return Number(insertFact.run(clean, now, now, source).lastInsertRowid);
}

export function updateFact(id: number, text: string, source: FactSource): boolean {
  const clean = cleanFact(text);
  if (!clean || !getFact(id)) return false;
  updateFactStmt.run(clean, Date.now(), source, id);
  return true;
}

export function removeFact(id: number): boolean {
  return deleteFact.run(id).changes > 0;
}

/** Saves the profile as it is now, so a bad rewrite can be undone. */
export function snapshotProfile(): void {
  insertSnapshot.run(Date.now(), JSON.stringify(listFacts()));
  pruneSnapshots.run();
}

function clock(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: process.env.SHIRO_TZ ?? "Asia/Hong_Kong" });
}

/** The profile for a prompt: each line dated, so an old one reads as possibly out of date. */
export function renderProfile(): string {
  const facts = listFacts();
  if (facts.length === 0) return "";
  return facts.map((f) => `- ${f.text} (${clock(f.updated_at)})`).join("\n");
}

/** The profile for the owner to read and correct: each line with the number they refer to it by. */
export function renderProfileNumbered(): string {
  const facts = listFacts();
  if (facts.length === 0) return "";
  return facts
    .map((f) => `${f.id}. ${f.text} (${clock(f.updated_at)}${f.source === "owner" ? ", 주인님이 직접 알려준 것" : ""})`)
    .join("\n");
}
