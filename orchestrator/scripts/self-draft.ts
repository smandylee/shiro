// The first draft of Shiro's own notes (src/memory/self.ts), made from what she remembers, for the
// owner to read before anything switches on. Run on the machine that holds her database, as the
// user the service runs as (a different user would leave root-owned files behind), with the same
// environment as the service:
//
//   cd ~/orchestrator
//   set -a; . /etc/shiro.env; set +a
//   npx tsx scripts/self-draft.ts            # reads her memories, writes data/self-draft.json, prints it
//   npx tsx scripts/self-draft.ts --write    # saves exactly that file as her notes and switches them on
//   npx tsx scripts/self-draft.ts --off      # switches the notes (and the nightly update) off again
//
// Nothing here changes how she talks until --write. The draft file is in data/, which git ignores.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../src/memory/db.js";
import { applyDraft, draftFromMemories, type SelfChanges } from "../src/memory/self-learn.js";
import { renderSelfNumbered, setSelfNotesOn } from "../src/memory/self.js";

const DRAFT_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "self-draft.json");
const MAX_MEMORIES = 150;
const CLIP = 300;
const TZ = process.env.SHIRO_TZ ?? "Asia/Hong_Kong";

const arg = process.argv[2];

if (arg === "--off") {
  setSelfNotesOn(false);
  console.log("self notes: off");
} else if (arg === "--write") {
  if (!existsSync(DRAFT_FILE)) throw new Error("no draft yet: run without arguments first");
  const changes = JSON.parse(readFileSync(DRAFT_FILE, "utf8")) as SelfChanges;
  const summary = applyDraft(changes, Date.now());
  setSelfNotesOn(true);
  console.log(`self notes: on (${summary})\n\n${renderSelfNumbered()}`);
} else {
  // Only her exchanges with the owner: the shared pool also holds what guests said.
  const rows = db
    .prepare(
      "SELECT user_text, assistant_text, created_at FROM long_memories WHERE speaker = '주인님' ORDER BY created_at DESC LIMIT ?"
    )
    .all(MAX_MEMORIES) as { user_text: string; assistant_text: string; created_at: number }[];
  if (rows.length === 0) throw new Error("no memories of the owner to read");

  const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP)}…` : s);
  const text = rows
    .reverse()
    .map((r) => {
      const at = new Date(r.created_at).toLocaleDateString("ko-KR", { timeZone: TZ, month: "numeric", day: "numeric" });
      return `(${at}) 주인님: ${clip(r.user_text)}\n(${at}) 시로: ${clip(r.assistant_text)}`;
    })
    .join("\n");

  const changes = await draftFromMemories(text);
  if (!changes) throw new Error("the model did not return a usable draft");
  writeFileSync(DRAFT_FILE, JSON.stringify(changes, null, 2));

  console.log(`read ${rows.length} memories; draft saved to data/self-draft.json\n`);
  for (const kind of ["taste", "habit", "bond"] as const) {
    const lines = changes.add.filter((n) => n.kind === kind);
    if (lines.length > 0) console.log(`[${kind}]\n${lines.map((n) => `- ${n.text}`).join("\n")}\n`);
  }
  if (changes.diary) console.log(`[diary]\n${changes.diary}\n`);
  console.log("If this reads right: npx tsx scripts/self-draft.ts --write");
}
