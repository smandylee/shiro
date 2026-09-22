import { db } from "./db.js";

// Development requests Shiro asks for in plain language ("메일 확인이 자꾸
//실패해요, 고쳐주세요"). She never writes the code herself: on approval the
// text is handed to Claude Code on the owner's PC, which does the work in an
// isolated git worktree. Nothing here can deploy anything — that stays manual.

db.exec(`
  CREATE TABLE IF NOT EXISTS dev_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    ok INTEGER,
    summary TEXT,
    branch TEXT,
    cost_usd REAL,
    touched_guardrails TEXT
  );
`);

// A request the owner never answered shouldn't stay approvable forever.
const PENDING_TTL_MS = 30 * 60 * 1000;
export const MAX_TASK_LENGTH = 2000;

export type DevTask = {
  id: number;
  task: string;
  reason: string | null;
  created_at: number;
};

const supersedeStmt = db.prepare("UPDATE dev_tasks SET status = 'superseded' WHERE status = 'pending'");
const insertStmt = db.prepare(
  "INSERT INTO dev_tasks (task, reason, status, created_at) VALUES (?, ?, 'pending', ?)"
);
const latestPendingStmt = db.prepare(
  "SELECT id, task, reason, created_at FROM dev_tasks WHERE status = 'pending' ORDER BY id DESC LIMIT 1"
);
const runningStmt = db.prepare("SELECT id, task, reason, created_at FROM dev_tasks WHERE status = 'running' LIMIT 1");
const setStatusStmt = db.prepare("UPDATE dev_tasks SET status = ? WHERE id = ?");
const finishStmt = db.prepare(
  `UPDATE dev_tasks SET status = ?, finished_at = ?, ok = ?, summary = ?, branch = ?, cost_usd = ?, touched_guardrails = ?
   WHERE id = ?`
);

/** Records a request, replacing any earlier one still waiting for an answer. */
export function proposeDevTask(task: string, reason?: string): DevTask | null {
  const clean = task.replace(/\s+/g, " ").trim().slice(0, MAX_TASK_LENGTH);
  if (!clean) return null;
  supersedeStmt.run();
  const info = insertStmt.run(clean, reason ?? null, Date.now());
  return { id: Number(info.lastInsertRowid), task: clean, reason: reason ?? null, created_at: Date.now() };
}

/** The request the owner can approve right now, or undefined if none or it expired. */
export function getPendingDevTask(): DevTask | undefined {
  const row = latestPendingStmt.get() as DevTask | undefined;
  if (!row) return undefined;
  if (Date.now() - row.created_at > PENDING_TTL_MS) {
    setStatusStmt.run("expired", row.id);
    return undefined;
  }
  return row;
}

/** One at a time: a second build while one is running would fight over the repo. */
export function getRunningDevTask(): DevTask | undefined {
  return runningStmt.get() as DevTask | undefined;
}

export function markDevTask(id: number, status: "running" | "cancelled" | "rejected"): void {
  setStatusStmt.run(status, id);
}

export type DevResult = {
  ok: boolean;
  summary: string;
  branch?: string | null;
  costUsd?: number | null;
  touchedGuardrails?: string[];
};

export function finishDevTask(id: number, result: DevResult): void {
  finishStmt.run(
    result.ok ? "done" : "failed",
    Date.now(),
    result.ok ? 1 : 0,
    result.summary.slice(0, 4000),
    result.branch ?? null,
    result.costUsd ?? null,
    result.touchedGuardrails?.length ? result.touchedGuardrails.join(", ") : null,
    id
  );
}
