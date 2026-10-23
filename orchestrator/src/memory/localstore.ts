import { db } from "./db.js";
import { fromBlob, normalize, toBlob, topMatches } from "./vector-math.js";

// Long-term memory kept in her own database, next to everything else she remembers.
//
// It used to live only in Pinecone, an ocean away: every search was a round trip to the US
// (~0.45s of the ~1.5s it took to remember anything), and every conversation she had was kept
// word for word by a third party. Here the same exchanges, the same vectors, live in one table
// on the machine she runs on, and a search is a loop over them.
//
// Every device talks to the one orchestrator, so this is shared by all of them exactly as
// Pinecone was; what it is not is anything that lives on the owner's PC.
//
// All memories are held in memory (about 3 KB each). That is a few MB for years of talk. It
// stops being a good idea somewhere past tens of thousands; that is the day to put an index
// behind it, not before.

db.exec(`
  CREATE TABLE IF NOT EXISTS long_memories (
    id TEXT PRIMARY KEY,
    speaker TEXT NOT NULL,
    user_text TEXT NOT NULL,
    assistant_text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    vector BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_long_memories_created ON long_memories(created_at);
`);

export type Memory = {
  id: string;
  speaker: string;
  userText: string;
  assistantText: string;
  createdAt: number;
  /** Normalized, so a dot product is the cosine similarity. */
  vec: Float32Array;
};

type Row = { id: string; speaker: string; user_text: string; assistant_text: string; created_at: number; vector: Buffer };

const selectAll = db.prepare("SELECT id, speaker, user_text, assistant_text, created_at, vector FROM long_memories ORDER BY created_at");
const insertOne = db.prepare(
  "INSERT OR IGNORE INTO long_memories (id, speaker, user_text, assistant_text, created_at, vector) VALUES (?, ?, ?, ?, ?, ?)"
);
const countAll = db.prepare("SELECT COUNT(*) AS n FROM long_memories");

let cache: Memory[] | null = null;

function all(): Memory[] {
  if (cache) return cache;
  cache = (selectAll.all() as Row[]).map((r) => ({
    id: r.id,
    speaker: r.speaker,
    userText: r.user_text,
    assistantText: r.assistant_text,
    createdAt: r.created_at,
    vec: fromBlob(r.vector),
  }));
  return cache;
}

export type NewMemory = {
  id: string;
  speaker: string;
  userText: string;
  assistantText: string;
  createdAt: number;
  /** As the embedding model gave it; stored normalized. */
  vector: ArrayLike<number>;
};

/** Stores one exchange. Returns false when that id was already there (importing twice is harmless). */
export function addMemory(m: NewMemory): boolean {
  if (m.vector.length === 0) throw new Error("a memory needs a vector");
  const vec = normalize(m.vector);
  const info = insertOne.run(m.id, m.speaker, m.userText, m.assistantText, m.createdAt, toBlob(vec));
  if (info.changes === 0) return false;
  cache?.push({ id: m.id, speaker: m.speaker, userText: m.userText, assistantText: m.assistantText, createdAt: m.createdAt, vec });
  return true;
}

export type Found = { memory: Memory; score: number };

/** The memories closest in meaning to `vector`, best first, none below `threshold`. */
export function searchMemories(vector: ArrayLike<number>, topK: number, threshold: number): Found[] {
  return topMatches(all(), normalize(vector), topK, threshold).map(({ item, score }) => ({ memory: item, score }));
}

export function memoryCount(): number {
  return (countAll.get() as { n: number }).n;
}

/** Reads the table into memory now, so the first real search does not pay for it. */
export function loadMemories(): number {
  return all().length;
}
