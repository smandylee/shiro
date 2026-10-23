import { readFileSync } from "node:fs";
import { Pinecone } from "@pinecone-database/pinecone";
import { db } from "./db.js";
import { embedText } from "./embeddings.js";
import { addMemory, memoryCount, searchMemories } from "./localstore.js";

// Moving long-term memory from Pinecone into her own database, and checking that nothing changed.
//
//   npx tsx src/memory/migrate.ts import <export.json>   put an export in (running it twice is harmless)
//   npx tsx src/memory/migrate.ts compare [n]            ask both stores the same questions, side by side
//   npx tsx src/memory/migrate.ts status                 how many memories each side has
//
// The export is a JSON file of Pinecone records with their vectors, as written by the backup step.
// Nothing is re-embedded: the vectors are carried over, so the same question finds the same
// memories with the same scores. `compare` is how that is checked before anything is switched.

const THRESHOLD = 0.65;
const TOP_K = 5;

type ExportRecord = { id: string; values: number[]; metadata?: Record<string, unknown> };

function pineconeIndex() {
  const key = process.env.PINECONE_API_KEY;
  if (!key) throw new Error("PINECONE_API_KEY is not set");
  const pc = new Pinecone({ apiKey: key });
  return pc.listIndexes().then((l) => {
    const found = l.indexes?.find((i) => i.name === "shiro-memory");
    if (!found) throw new Error('no Pinecone index named "shiro-memory"');
    return pc.index("shiro-memory", found.host);
  });
}

function importFile(path: string): void {
  const data = JSON.parse(readFileSync(path, "utf8")) as { records?: ExportRecord[] };
  const records = data.records ?? [];
  let added = 0;
  let skipped = 0;
  let bad = 0;
  const run = db.transaction(() => {
    for (const r of records) {
      const m = r.metadata ?? {};
      if (!Array.isArray(r.values) || r.values.length === 0 || typeof m.userText !== "string" || typeof m.assistantText !== "string") {
        bad++;
        continue;
      }
      const inserted = addMemory({
        id: r.id,
        speaker: String(m.speakerName ?? "주인님"),
        userText: m.userText,
        assistantText: m.assistantText,
        createdAt: typeof m.createdAt === "number" ? m.createdAt : 0,
        vector: r.values,
      });
      if (inserted) added++;
      else skipped++;
    }
  });
  run();
  console.log(`imported ${added} new, ${skipped} already there, ${bad} unusable, of ${records.length} in the file | her database now holds ${memoryCount()}`);
}

/** Real things the owner has said lately, plus a few fixed ones: what a question looks like when she asks it. */
function sampleQueries(n: number): string[] {
  const fixed = ["저번에 시험 얘기했던 거", "주인님이 좋아하는 음식", "마인크래프트 계획", "오늘 일정이 뭐였지", "프로젝트 마감", "친구랑 약속", "새로 산 거", "공부하기 싫다"];
  const channel = (db.prepare("SELECT value FROM settings WHERE key = 'ownerChannelId'").get() as { value: string } | undefined)?.value;
  const said = channel
    ? (db.prepare("SELECT text FROM turns WHERE channel_id = ? AND role = 'user' ORDER BY id DESC LIMIT 400").all(channel) as { text: string }[])
        .map((r) => r.text.trim())
        .filter((t) => t.length >= 6 && t.length <= 200 && !t.startsWith("("))
    : [];
  return [...new Set([...said.slice(0, Math.max(0, n - fixed.length)), ...fixed])].slice(0, n);
}

async function compare(n: number): Promise<void> {
  const index = await pineconeIndex();
  const queries = sampleQueries(n);
  let sameOrder = 0;
  let sameSet = 0;
  let withHits = 0;
  let maxDiff = 0;
  const differences: string[] = [];

  for (const q of queries) {
    const vector = await embedText(q, "RETRIEVAL_QUERY");
    const remote = ((await index.query({ vector, topK: TOP_K, includeMetadata: false })).matches ?? [])
      .filter((m) => (m.score ?? 0) >= THRESHOLD)
      .map((m) => ({ id: m.id, score: m.score ?? 0 }));
    const local = searchMemories(vector, TOP_K, THRESHOLD).map((f) => ({ id: f.memory.id, score: f.score }));

    if (remote.length > 0 || local.length > 0) withHits++;
    const a = remote.map((x) => x.id).join(",");
    const b = local.map((x) => x.id).join(",");
    if (a === b) sameOrder++;
    if ([...remote.map((x) => x.id)].sort().join(",") === [...local.map((x) => x.id)].sort().join(",")) sameSet++;
    for (const r of remote) {
      const l = local.find((x) => x.id === r.id);
      if (l) maxDiff = Math.max(maxDiff, Math.abs(l.score - r.score));
    }
    if (a !== b) differences.push(`  "${q.slice(0, 40)}"\n    pinecone: ${remote.map((x) => x.score.toFixed(3)).join(" ") || "-"}\n    local:    ${local.map((x) => x.score.toFixed(3)).join(" ") || "-"}`);
  }

  console.log(`${queries.length} questions (${withHits} found something): same memories in the same order ${sameOrder}, same memories ${sameSet} | largest score difference ${maxDiff.toExponential(2)}`);
  if (differences.length > 0) console.log(`differences:\n${differences.slice(0, 6).join("\n")}`);
}

async function status(): Promise<void> {
  const index = await pineconeIndex();
  const stats = await index.describeIndexStats();
  console.log(`pinecone: ${stats.totalRecordCount ?? "?"} | her database: ${memoryCount()}`);
}

const [command, arg] = process.argv.slice(2);
if (command === "import" && arg) importFile(arg);
else if (command === "compare") await compare(Number(arg) || 40);
else if (command === "status") await status();
else {
  console.error("usage: migrate.ts import <export.json> | compare [n] | status");
  process.exit(1);
}
