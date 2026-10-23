import { Pinecone } from "@pinecone-database/pinecone";
import { embedText, EMBEDDING_DIMENSION } from "./embeddings.js";
import { addMemory, loadMemories, searchMemories } from "./localstore.js";

const INDEX_NAME = "shiro-memory";
const apiKey = process.env.PINECONE_API_KEY;

let ready: Promise<void> | null = null;
const pinecone = apiKey ? new Pinecone({ apiKey }) : null;

/**
 * Where long-term memory lives, set with SHIRO_MEMORY_STORE:
 *   pinecone    Pinecone only. What an install that predates the local store does.
 *   local       Her own database is read and written; Pinecone, if there is a key, is also written to,
 *               so switching back loses nothing while there is any doubt.
 *   local-only  Her own database only. Needs no account anywhere.
 * Unset: an install with a Pinecone key keeps using it, and one without gets the local store
 * (it used to have no long-term memory at all).
 */
export type StoreMode = "pinecone" | "local" | "local-only";
export function storeMode(): StoreMode {
  const raw = (process.env.SHIRO_MEMORY_STORE ?? "").trim().toLowerCase();
  if (raw === "pinecone" || raw === "local" || raw === "local-only") return raw;
  return apiKey ? "pinecone" : "local-only";
}

if (storeMode() === "pinecone" && !apiKey) {
  console.warn("[memory] SHIRO_MEMORY_STORE=pinecone but PINECONE_API_KEY is not set — long-term memory disabled.");
}

// What a search must score to count as the same subject: the same floor as when Pinecone did it.
const SIMILARITY_THRESHOLD = 0.65;

// The index handle is made once, with its address. Asking the SDK for
// `pinecone.index(name)` on every call makes it look the address up again
// (~0.2s per call, and ~0.8s the first time from Hong Kong).
let handle: ReturnType<Pinecone["index"]> | null = null;

async function ensureIndex(): Promise<void> {
  if (!pinecone) return;
  if (!ready) {
    ready = (async () => {
      const existing = await pinecone.listIndexes();
      const found = existing.indexes?.find((idx) => idx.name === INDEX_NAME);
      if (found) {
        handle = pinecone.index(INDEX_NAME, found.host);
        return;
      }
      console.log(`[memory] creating pinecone index "${INDEX_NAME}"...`);
      const created = await pinecone.createIndex({
        name: INDEX_NAME,
        dimension: EMBEDDING_DIMENSION,
        metric: "cosine",
        spec: { serverless: { cloud: "aws", region: "us-east-1" } },
        waitUntilReady: true,
      });
      handle = pinecone.index(INDEX_NAME, created?.host);
    })();
  }
  await ready;
}

function memoryIndex() {
  return handle ?? pinecone!.index(INDEX_NAME);
}

/**
 * Sets up the connections ahead of the first real message — the index address
 * and both network paths — so the first reply after a restart isn't the slow one.
 */
export async function warmMemory(): Promise<void> {
  const mode = storeMode();
  if (mode === "pinecone" && !pinecone) return;
  try {
    const vector = await embedText("워밍업", "RETRIEVAL_QUERY");
    if (mode === "pinecone") {
      await ensureIndex();
      await memoryIndex().query({ vector, topK: 1 });
      console.log("[memory] warmed up (pinecone)");
      return;
    }
    const count = loadMemories();
    if (mode === "local" && pinecone) await ensureIndex(); // the mirror's address, looked up now instead of on the first write
    console.log(`[memory] warmed up (${mode}: ${count} memories in her own database${mode === "local" && pinecone ? ", mirrored to pinecone" : ""})`);
  } catch (err) {
    console.error("[memory] warm-up failed:", err);
  }
}

/**
 * Stores one exchange so it can be found by meaning later.
 */
export async function remember(
  speakerName: string,
  userText: string,
  assistantText: string
): Promise<void> {
  const mode = storeMode();
  if (mode === "pinecone" && !pinecone) return;
  try {
    // Embed the whole exchange, not just the user's line — questions like
    // "뭐 추천해줬어?" are answered by what Shiro said, so the reply has to be
    // part of what gets matched.
    const vector = await embedText(
      `${speakerName}: ${userText}\n시로: ${assistantText}`,
      "RETRIEVAL_DOCUMENT"
    );
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();

    if (mode !== "pinecone") addMemory({ id, speaker: speakerName, userText, assistantText, createdAt, vector });

    if (mode !== "local-only" && pinecone) {
      try {
        await ensureIndex();
        await memoryIndex().upsert({
          records: [{ id, values: vector, metadata: { speakerName, userText, assistantText, createdAt } }],
        });
      } catch (err) {
        // With Pinecone as the only store a failure is a failure; as a mirror it must not lose what is already safe.
        if (mode === "pinecone") throw err;
        console.error("[memory] mirroring to pinecone failed (the memory itself is saved):", err);
      }
    }
  } catch (err) {
    console.error("[memory] remember failed:", err);
  }
}

// Recalled lines carry no date otherwise, so Shiro can't tell an exchange from
// yesterday apart from one a month ago.
function formatWhen(createdAt: unknown): string {
  if (typeof createdAt !== "number") return "(시점 불명)";
  return new Date(createdAt).toLocaleString("ko-KR", {
    timeZone: "Asia/Hong_Kong",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatMemory(createdAt: unknown, speaker: unknown, userText: unknown, assistantText: unknown): string {
  return `- ${formatWhen(createdAt)} ${speaker}: ${userText}\n  시로: ${assistantText}`;
}

export async function recall(queryText: string, topK = 5): Promise<string[]> {
  const mode = storeMode();
  if (mode === "pinecone" && !pinecone) return [];
  try {
    const vector = await embedText(queryText, "RETRIEVAL_QUERY");

    if (mode !== "pinecone") {
      return searchMemories(vector, topK, SIMILARITY_THRESHOLD).map(({ memory }) =>
        formatMemory(memory.createdAt, memory.speaker, memory.userText, memory.assistantText)
      );
    }

    await ensureIndex();
    const result = await memoryIndex().query({
      vector,
      topK,
      includeMetadata: true,
    });

    return (result.matches ?? [])
      .filter((match) => (match.score ?? 0) >= SIMILARITY_THRESHOLD)
      .map((match) => {
        const meta = match.metadata as Record<string, unknown>;
        return formatMemory(meta.createdAt, meta.speakerName, meta.userText, meta.assistantText);
      });
  } catch (err) {
    console.error("[memory] recall failed:", err);
    return [];
  }
}
