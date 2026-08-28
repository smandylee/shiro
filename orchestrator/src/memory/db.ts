import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "..", "data");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, "memory.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_turns_channel ON turns(channel_id, id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notified_events (
    event_id TEXT PRIMARY KEY,
    notified_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contacts (
    discord_user_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    note TEXT,
    updated_at INTEGER NOT NULL
  );

  -- Per-day model usage, split by which part of Shiro spent it, so a bill
  -- spike can be attributed without guessing.
  CREATE TABLE IF NOT EXISTS usage_daily (
    day TEXT NOT NULL,
    source TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, source)
  );

  -- Things to do that aren't tied to a clock time, so they don't belong in the
  -- calendar. due_at is optional.
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    due_at INTEGER,
    done INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    done_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_todos_open ON todos(done, due_at);

  -- Shell commands Shiro wants to run, held until the owner approves them.
  CREATE TABLE IF NOT EXISTS pending_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL
  );
`);
