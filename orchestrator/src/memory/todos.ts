import { db } from "./db.js";

const insertStmt = db.prepare(
  "INSERT INTO todos (text, due_at, done, created_at) VALUES (?, ?, 0, ?)"
);
const openStmt = db.prepare(
  // Undated items sort last, otherwise NULL would lead the list.
  "SELECT id, text, due_at, done FROM todos WHERE done = 0 ORDER BY due_at IS NULL, due_at ASC, id ASC"
);
const recentDoneStmt = db.prepare(
  "SELECT id, text, due_at, done FROM todos WHERE done = 1 ORDER BY done_at DESC LIMIT ?"
);
const getStmt = db.prepare("SELECT id, text, due_at, done FROM todos WHERE id = ?");
const completeStmt = db.prepare("UPDATE todos SET done = 1, done_at = ? WHERE id = ? AND done = 0");
const deleteStmt = db.prepare("DELETE FROM todos WHERE id = ?");
const dueBeforeStmt = db.prepare(
  "SELECT id, text, due_at, done FROM todos WHERE done = 0 AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at ASC"
);

export type Todo = {
  id: number;
  text: string;
  due_at: number | null;
  done: number;
};

export function addTodo(text: string, dueIso?: string): Todo {
  const due = dueIso ? new Date(dueIso).getTime() : null;
  const info = insertStmt.run(text, Number.isNaN(due) ? null : due, Date.now());
  return getStmt.get(Number(info.lastInsertRowid)) as Todo;
}

export function listOpenTodos(): Todo[] {
  return openStmt.all() as Todo[];
}

export function listRecentlyDone(limit = 5): Todo[] {
  return recentDoneStmt.all(limit) as Todo[];
}

export function getTodo(id: number): Todo | undefined {
  return getStmt.get(id) as Todo | undefined;
}

export function completeTodo(id: number): boolean {
  return completeStmt.run(Date.now(), id).changes > 0;
}

export function removeTodo(id: number): boolean {
  return deleteStmt.run(id).changes > 0;
}

/** Open items already due (or due within `withinMs`), for proactive nudges. */
export function todosDueBy(withinMs: number): Todo[] {
  return dueBeforeStmt.all(Date.now() + withinMs) as Todo[];
}

export function formatTodo(t: Todo): string {
  if (t.due_at == null) return `- [${t.id}] ${t.text}`;
  const when = new Date(t.due_at).toLocaleString("ko-KR", {
    timeZone: "Asia/Hong_Kong",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const overdue = t.due_at < Date.now() && !t.done ? " ⚠️ 기한 지남" : "";
  return `- [${t.id}] ${t.text} (기한: ${when})${overdue}`;
}
