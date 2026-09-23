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
    touched_guardrails TEXT,
    verdict TEXT,
    deploy_status TEXT,
    deployed_at INTEGER,
    deploy_summary TEXT
  );
`);

// Tables made before those last four columns existed are still full of real
// history, so they get the columns rather than a fresh start.
{
  const existing = new Set(
    (db.prepare("PRAGMA table_info(dev_tasks)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const [name, type] of [
    ["verdict", "TEXT"],
    ["deploy_status", "TEXT"],
    ["deployed_at", "INTEGER"],
    ["deploy_summary", "TEXT"],
  ] as const) {
    if (!existing.has(name)) db.exec(`ALTER TABLE dev_tasks ADD COLUMN ${name} ${type}`);
  }
}

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
  `UPDATE dev_tasks SET status = ?, finished_at = ?, ok = ?, summary = ?, branch = ?, cost_usd = ?, touched_guardrails = ?,
   verdict = ? WHERE id = ?`
);
const byIdStmt = db.prepare("SELECT * FROM dev_tasks WHERE id = ?");
// Only a build that finished, produced a branch, and wasn't refused can be shipped.
const deployableStmt = db.prepare(
  `SELECT * FROM dev_tasks
   WHERE status = 'done' AND ok = 1 AND branch IS NOT NULL AND verdict = 'done'
     AND (deploy_status IS NULL OR deploy_status = 'deploy_failed')
   ORDER BY id DESC LIMIT 1`
);
const deployingStmt = db.prepare("SELECT * FROM dev_tasks WHERE deploy_status = 'deploying' LIMIT 1");
const setDeployStatusStmt = db.prepare("UPDATE dev_tasks SET deploy_status = ? WHERE id = ?");
const finishDeployStmt = db.prepare(
  "UPDATE dev_tasks SET deploy_status = ?, deployed_at = ?, deploy_summary = ? WHERE id = ?"
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

/** What the run decided. "declined" and "escalated" both leave the code alone,
 *  but only "escalated" is work still waiting for someone. */
export type DevVerdict = "done" | "declined" | "escalated" | "failed";

export type DevResult = {
  ok: boolean;
  verdict?: string | null;
  summary: string;
  branch?: string | null;
  costUsd?: number | null;
  touchedGuardrails?: string[];
};

export type DevTaskRow = {
  id: number;
  task: string;
  status: string;
  ok: number | null;
  verdict: string | null;
  summary: string | null;
  branch: string | null;
  touched_guardrails: string | null;
  deploy_status: string | null;
  deploy_summary: string | null;
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
    result.verdict ?? (result.ok ? "done" : "failed"),
    id
  );
}

export function getDevTask(id: number): DevTaskRow | undefined {
  return byIdStmt.get(id) as DevTaskRow | undefined;
}

/** The build the owner can put on the server right now — the latest one, or a named one. */
export function getDeployableDevTask(id?: number): DevTaskRow | undefined {
  if (id === undefined) return deployableStmt.get() as DevTaskRow | undefined;
  return byIdStmt.get(id) as DevTaskRow | undefined;
}

/** One deploy at a time, and a restart mid-deploy shouldn't lose that it started. */
export function getDeployingDevTask(): DevTaskRow | undefined {
  return deployingStmt.get() as DevTaskRow | undefined;
}

export function markDeploying(id: number): void {
  setDeployStatusStmt.run("deploying", id);
}

export function finishDeploy(id: number, ok: boolean, summary: string): void {
  finishDeployStmt.run(ok ? "deployed" : "deploy_failed", Date.now(), summary.slice(0, 4000), id);
}
