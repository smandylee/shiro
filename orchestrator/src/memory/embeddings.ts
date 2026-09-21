import { GoogleGenAI } from "@google/genai";

// Embeddings get their own regional client. Through the shared `global`
// endpoint this model answered in ~0.3s on a warm connection but ~11s whenever
// the connection had sat idle a few seconds — which is nearly every real reply,
// since recall runs first. Regional endpoints measured 0.6-1.2s from cold.
// Same model, so the vectors stay comparable with what's already in Pinecone.
const EMBEDDING_LOCATION = process.env.EMBEDDING_LOCATION ?? "asia-east2";
const project = process.env.GOOGLE_CLOUD_PROJECT;
if (!project) {
  throw new Error("GOOGLE_CLOUD_PROJECT is not set");
}
const embeddingAi = new GoogleGenAI({ vertexai: true, project, location: EMBEDDING_LOCATION });

const EMBEDDING_MODEL = "text-multilingual-embedding-002";
export const EMBEDDING_DIMENSION = 768;

export type EmbedTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export async function embedText(text: string, taskType: EmbedTaskType): Promise<number[]> {
  const response = await embeddingAi.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
    config: { taskType, outputDimensionality: EMBEDDING_DIMENSION },
  });

  const values = response.embeddings?.[0]?.values;
  if (!values) {
    throw new Error(`empty embedding response: ${JSON.stringify(response)}`);
  }
  return values;
}
