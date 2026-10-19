import { db } from "./db.js";
import type { Emotion } from "../persona.js";
import {
  MOOD_MAX,
  MOOD_MIN,
  MOOD_REST,
  clamp,
  cleanNote,
  moodAt,
  nudgeFor,
  renderMoodBlock,
  type MoodState,
} from "./mood-core.js";

// How she feels today, kept between days. One row. See mood-core.ts for how it moves.

db.exec(`
  CREATE TABLE IF NOT EXISTS mood_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mood REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    note_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
`);

type Row = { mood: number; note: string; note_at: number; updated_at: number };

const selectRow = db.prepare("SELECT mood, note, note_at, updated_at FROM mood_state WHERE id = 1");
const upsertRow = db.prepare(
  `INSERT INTO mood_state (id, mood, note, note_at, updated_at) VALUES (1, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET mood = excluded.mood,
     note = excluded.note, note_at = excluded.note_at, updated_at = excluded.updated_at`
);

export function getMoodState(): MoodState {
  const row = selectRow.get() as Row | undefined;
  if (!row) return { mood: MOOD_REST, note: "", noteAt: 0, updatedAt: Date.now() };
  return { mood: row.mood, note: row.note, noteAt: row.note_at, updatedAt: row.updated_at };
}

function save(state: MoodState): void {
  upsertRow.run(state.mood, state.note, state.noteAt, state.updatedAt);
}

/**
 * The owner said something and she answered with `emotion`: the mood drifts to
 * where it is now and is nudged by what she just felt.
 */
export function noteOwnerTurn(emotion: Emotion, now = Date.now()): void {
  try {
    const state = getMoodState();
    save({ ...state, mood: clamp(moodAt(state, now) + nudgeFor(emotion), MOOD_MIN, MOOD_MAX), updatedAt: now });
  } catch (err) {
    // Her mood must never be the reason an answer doesn't go out.
    console.error("[mood] could not record the turn:", err);
  }
}

export type Reflection = { note: string };

/** What the night's reflection decided: the feeling she carries into the next day, in words. The mood number is left to fade on its own. */
export function applyReflection(r: Reflection, now = Date.now()): string {
  const note = cleanNote(r.note);
  // The mood and its clock stay as they were: only the leftover feeling changes.
  save({ ...getMoodState(), note, noteAt: note ? now : 0 });
  return note ? `note="${note}"` : "nothing carried over";
}

/** The mood paragraph for a prompt, or "" when she is in her usual state. */
export function moodBlock(now = Date.now()): string {
  try {
    return renderMoodBlock(getMoodState(), now);
  } catch (err) {
    console.error("[mood] could not read the mood:", err);
    return "";
  }
}
