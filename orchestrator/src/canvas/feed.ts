import { db } from "../memory/db.js";

// Read-only view of the owner's Canvas deadlines. The school has switched off
// personal API tokens, so this reads the calendar feed Canvas hands out for
// subscribing in other calendar apps. It carries only items that have a due
// date — assignments and quizzes — and no submission status, no announcements
// and no grades. Nothing here can change anything in Canvas.

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
// The Canvas account is set to Hong Kong time. The feed gives a due date with no
// time when the deadline is 23:59 that day.
const CANVAS_UTC_OFFSET = "+08:00";
const DISPLAY_TZ = "Asia/Hong_Kong";

export type CanvasItem = {
  id: string;
  title: string;
  course: string | null;
  dueMs: number;
  url: string | null;
  details: string;
};

const isDoneStmt = db.prepare("SELECT 1 FROM canvas_done WHERE uid = ?");
const markDoneStmt = db.prepare("INSERT OR REPLACE INTO canvas_done (uid, done_at) VALUES (?, ?)");

export function canvasEnabled(): boolean {
  return Boolean(process.env.CANVAS_ICS_URL);
}

/* ---------- parsing ---------- */

function unescapeText(s: string): string {
  return s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function parseDue(value: string): number | null {
  const stamp = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (stamp) return Date.UTC(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5], +stamp[6]);
  const day = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (day) return new Date(`${day[1]}-${day[2]}-${day[3]}T23:59:00${CANVAS_UTC_OFFSET}`).getTime();
  return null;
}

/** Turns the raw ICS text into items. Pure, so it can be tested without a network. */
export function parseFeed(ics: string): CanvasItem[] {
  // Long lines are folded onto the next line, which starts with a space or tab.
  const text = ics.replace(/\r?\n[ \t]/g, "");
  const items: CanvasItem[] = [];

  for (const block of text.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    const prop = (name: string): string => {
      const m = body.match(new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(.*)$`, "m"));
      return m ? m[1].replace(/\r$/, "") : "";
    };

    const id = prop("UID").trim();
    const dueMs = parseDue(prop("DTSTART").trim());
    const summary = unescapeText(prop("SUMMARY")).trim();
    if (!id || dueMs === null || !summary) continue;

    // "Draft 1 [APSS1BN30_26271_RW_C]" — the bracket is the course section.
    const tag = summary.match(/\s*\[([A-Za-z0-9]+)_[^\]]*\]\s*$/);
    items.push({
      id,
      title: tag ? summary.slice(0, tag.index).trim() : summary,
      course: tag ? tag[1] : null,
      dueMs,
      url: prop("URL").trim() || null,
      details: unescapeText(prop("DESCRIPTION")).replace(/\s+/g, " ").trim().slice(0, 400),
    });
  }
  return items.sort((a, b) => a.dueMs - b.dueMs);
}

/* ---------- fetching ---------- */

let cache: { at: number; items: CanvasItem[] } | null = null;

async function loadFeed(): Promise<CanvasItem[]> {
  const url = process.env.CANVAS_ICS_URL;
  if (!url) throw new Error("CANVAS_ICS_URL is not set");

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.items;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`canvas feed returned ${res.status}`);
    cache = { at: Date.now(), items: parseFeed(await res.text()) };
  } catch (err) {
    // A stale list beats none: deadlines don't move much within a day.
    // (Never log the URL — it is a secret link.)
    if (cache) return cache.items;
    throw err;
  }
  return cache.items;
}

/** Deadlines still ahead, soonest first, leaving out anything already marked handed in. */
export async function listUpcomingCanvas(withinDays = 14): Promise<CanvasItem[]> {
  const now = Date.now();
  const until = now + withinDays * 24 * 60 * 60 * 1000;
  return (await loadFeed()).filter((i) => i.dueMs > now && i.dueMs <= until && !isDoneStmt.get(i.id));
}

/** Marks an item as handed in; returns its title, or null when no current item has that id. */
export async function markCanvasDone(id: string): Promise<string | null> {
  const item = (await loadFeed()).find((i) => i.id === id.trim());
  if (!item) return null;
  markDoneStmt.run(item.id, Date.now());
  return item.title;
}

/* ---------- presentation ---------- */

export function dueLabel(dueMs: number): string {
  return new Date(dueMs).toLocaleString("ko-KR", {
    timeZone: DISPLAY_TZ,
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function describeItem(i: CanvasItem, withId = false): string {
  return `- ${withId ? `[id:${i.id}] ` : ""}${dueLabel(i.dueMs)} 마감 ${i.course ? `[${i.course}] ` : ""}${i.title}`;
}
