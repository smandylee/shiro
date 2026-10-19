import { db } from "./db.js";
import { getSetting, setSetting } from "./settings.js";
import type { Emotion } from "../persona.js";
import {
  AFFINITY_MAX,
  AFFINITY_MIN,
  AFFINITY_PER_DAY,
  AFFINITY_START,
  MAX_NIGHTLY_AFFINITY,
  MOOD_MAX,
  MOOD_MIN,
  MOOD_REST,
  affinityAfterSilence,
  clamp,
  cleanNote,
  moodAt,
  nudgeFor,
  renderMoodBlock,
  type MoodState,
} from "./mood-core.js";

// How she feels today and how close she is to the owner, kept between days.
// One row. See mood-core.ts for how the numbers move.

db.exec(`
  CREATE TABLE IF NOT EXISTS mood_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mood REAL NOT NULL,
    affinity REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    note_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
`);

const TZ = process.env.SHIRO_TZ ?? "Asia/Hong_Kong";

type Row = { mood: number; affinity: number; note: string; note_at: number; updated_at: number };

const selectRow = db.prepare("SELECT mood, affinity, note, note_at, updated_at FROM mood_state WHERE id = 1");
const upsertRow = db.prepare(
  `INSERT INTO mood_state (id, mood, affinity, note, note_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET mood = excluded.mood, affinity = excluded.affinity,
     note = excluded.note, note_at = excluded.note_at, updated_at = excluded.updated_at`
);

export function getMoodState(): MoodState {
  const row = selectRow.get() as Row | undefined;
  if (!row) return { mood: MOOD_REST, affinity: AFFINITY_START, note: "", noteAt: 0, updatedAt: Date.now() };
  return { mood: row.mood, affinity: row.affinity, note: row.note, noteAt: row.note_at, updatedAt: row.updated_at };
}

function save(state: MoodState): void {
  upsertRow.run(state.mood, state.affinity, state.note, state.noteAt, state.updatedAt);
}

function dayOf(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
}

/**
 * The owner said something and she answered with `emotion`: the mood drifts to
 * where it is now and is nudged by what she just felt. The first word of a day
 * also warms closeness a little; a long silence before it cools it first.
 */
export function noteOwnerTurn(emotion: Emotion, now = Date.now()): void {
  try {
    const state = getMoodState();
    const next: MoodState = {
      ...state,
      mood: clamp(moodAt(state, now) + nudgeFor(emotion), MOOD_MIN, MOOD_MAX),
      updatedAt: now,
    };

    const lastDay = getSetting("moodLastTalkDay");
    const today = dayOf(now);
    if (lastDay !== today) {
      const lastAt = Number(getSetting("moodLastTalkAt") ?? 0) || null;
      const cooled = affinityAfterSilence(state.affinity, lastAt, now);
      next.affinity = clamp(cooled + AFFINITY_PER_DAY, AFFINITY_MIN, AFFINITY_MAX);
      setSetting("moodLastTalkDay", today);
    }
    setSetting("moodLastTalkAt", String(now));
    save(next);
  } catch (err) {
    // Her mood must never be the reason an answer doesn't go out.
    console.error("[mood] could not record the turn:", err);
  }
}

export type Reflection = { note: string; mood: number; affinityDelta: number };

/** What the night's reflection decided: the feeling she wakes up with, and how the day moved closeness. */
export function applyReflection(r: Reflection, now = Date.now()): string {
  const state = getMoodState();
  const note = cleanNote(r.note);
  const delta = clamp(r.affinityDelta, -MAX_NIGHTLY_AFFINITY, MAX_NIGHTLY_AFFINITY);
  const next: MoodState = {
    mood: clamp(r.mood, MOOD_MIN, MOOD_MAX),
    affinity: clamp(state.affinity + delta, AFFINITY_MIN, AFFINITY_MAX),
    note,
    noteAt: note ? now : 0,
    updatedAt: now,
  };
  save(next);
  return `mood ${state.mood.toFixed(2)}→${next.mood.toFixed(2)}, affinity ${state.affinity.toFixed(1)}→${next.affinity.toFixed(1)}${note ? `, note="${note}"` : ""}`;
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
