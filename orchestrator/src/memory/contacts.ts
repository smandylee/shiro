import { db } from "./db.js";

const getStmt = db.prepare("SELECT name, note FROM contacts WHERE discord_user_id = ?");
const setStmt = db.prepare(
  `INSERT INTO contacts (discord_user_id, name, note, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(discord_user_id) DO UPDATE SET name = excluded.name, note = excluded.note, updated_at = excluded.updated_at`
);
const listStmt = db.prepare("SELECT discord_user_id, name, note FROM contacts ORDER BY updated_at DESC");

export type Contact = { name: string; note: string | null };
export type ContactEntry = { discord_user_id: string; name: string; note: string | null };

export function getContact(userId: string): Contact | undefined {
  return getStmt.get(userId) as Contact | undefined;
}

export function setContact(userId: string, name: string, note?: string): void {
  setStmt.run(userId, name, note ?? null, Date.now());
}

export function listContacts(): ContactEntry[] {
  return listStmt.all() as ContactEntry[];
}

// Exact (case- and whitespace-insensitive) name match only — never fuzzy, so
// Shiro can't silently send a message to the wrong person. Returns every match
// so the caller can refuse when a name is ambiguous.
export function findContactsByName(name: string): ContactEntry[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  return listContacts().filter((c) => c.name.trim().toLowerCase() === needle);
}
