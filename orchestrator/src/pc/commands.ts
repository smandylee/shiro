import { db } from "../memory/db.js";

// A proposal the owner never got around to answering shouldn't stay approvable
// forever — otherwise a stale "yes" could fire a command from an hour ago.
const PENDING_TTL_MS = 10 * 60 * 1000;

const insertStmt = db.prepare(
  "INSERT INTO pending_commands (command, reason, created_at, status) VALUES (?, ?, ?, 'pending')"
);
const expireOthersStmt = db.prepare(
  "UPDATE pending_commands SET status = 'superseded' WHERE status = 'pending'"
);
const latestPendingStmt = db.prepare(
  "SELECT id, command, reason, created_at FROM pending_commands WHERE status = 'pending' ORDER BY id DESC LIMIT 1"
);
const setStatusStmt = db.prepare("UPDATE pending_commands SET status = ? WHERE id = ?");

export type PendingCommand = {
  id: number;
  command: string;
  reason: string | null;
  created_at: number;
};

/** Records a proposal, replacing any earlier one that's still unanswered. */
export function proposeCommand(command: string, reason?: string): PendingCommand {
  expireOthersStmt.run();
  const info = insertStmt.run(command, reason ?? null, Date.now());
  return {
    id: Number(info.lastInsertRowid),
    command,
    reason: reason ?? null,
    created_at: Date.now(),
  };
}

/** The current approvable proposal, or undefined if there is none or it expired. */
export function getPendingCommand(): PendingCommand | undefined {
  const row = latestPendingStmt.get() as PendingCommand | undefined;
  if (!row) return undefined;
  if (Date.now() - row.created_at > PENDING_TTL_MS) {
    setStatusStmt.run("expired", row.id);
    return undefined;
  }
  return row;
}

export function markCommand(id: number, status: "approved" | "rejected"): void {
  setStatusStmt.run(status, id);
}

export function cancelPending(): boolean {
  const row = latestPendingStmt.get() as PendingCommand | undefined;
  if (!row) return false;
  setStatusStmt.run("rejected", row.id);
  return true;
}
