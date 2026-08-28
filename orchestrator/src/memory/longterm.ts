import { Pinecone } from "@pinecone-database/pinecone";
import { embedText, EMBEDDING_DIMENSION } from "./embeddings.js";

const INDEX_NAME = "shiro-memory";
const apiKey = process.env.PINECONE_API_KEY;

let ready: Promise<void> | null = null;
const pinecone = apiKey ? new Pinecone({ apiKey }) : null;

if (!apiKey) {
  console.warn("[memory] PINECONE_API_KEY not set — long-term memory disabled.");
}

async function ensureIndex(): Promise<void> {
  if (!pinecone) return;
  if (!ready) {
    ready = (async () => {
      const existing = await pinecone.listIndexes();
      const exists = existing.indexes?.some((idx) => idx.name === INDEX_NAME);
      if (!exists) {
        console.log(`[memory] creating pinecone index "${INDEX_NAME}"...`);
        await pinecone.createIndex({
          name: INDEX_NAME,
          dimension: EMBEDDING_DIMENSION,
          metric: "cosine",
          spec: { serverless: { cloud: "aws", region: "us-east-1" } },
          waitUntilReady: true,
        });
      }
    })();
  }
  await ready;
}

// Long-term memory is a single shared pool across everyone Shiro talks to
// (not scoped per Discord channel), so general conversation carries over
// between the owner and guests. Each entry is tagged with who said it so
// recall results stay clearly attributed and don't get people confused.
export async function remember(
  speakerName: string,
  userText: string,
  assistantText: string
): Promise<void> {
  if (!pinecone) return;
  try {
    await ensureIndex();
    // Embed the whole exchange, not just the user's line — questions like
    // "뭐 추천해줬어?" are answered by what Shiro said, so the reply has to be
    // part of what gets matched.
    const vector = await embedText(
      `${speakerName}: ${userText}\n시로: ${assistantText}`,
      "RETRIEVAL_DOCUMENT"
    );
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await pinecone.index(INDEX_NAME).upsert({
      records: [
        {
          id,
          values: vector,
          metadata: {
            speakerName,
            userText,
            assistantText,
            createdAt: Date.now(),
          },
        },
      ],
    });
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

export async function recall(queryText: string, topK = 5): Promise<string[]> {
  if (!pinecone) return [];
  try {
    await ensureIndex();
    const vector = await embedText(queryText, "RETRIEVAL_QUERY");
    const result = await pinecone.index(INDEX_NAME).query({
      vector,
      topK,
      includeMetadata: true,
    });

    const SIMILARITY_THRESHOLD = 0.65;
    return (result.matches ?? [])
      .filter((match) => (match.score ?? 0) >= SIMILARITY_THRESHOLD)
      .map((match) => {
        const meta = match.metadata as Record<string, unknown>;
        const when = formatWhen(meta.createdAt);
        return `- ${when} ${meta.speakerName}: ${meta.userText}\n  시로: ${meta.assistantText}`;
      });
  } catch (err) {
    console.error("[memory] recall failed:", err);
    return [];
  }
}
