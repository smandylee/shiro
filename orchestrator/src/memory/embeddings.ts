import { ai } from "../llm/client.js";

const EMBEDDING_MODEL = "text-multilingual-embedding-002";
export const EMBEDDING_DIMENSION = 768;

export type EmbedTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export async function embedText(text: string, taskType: EmbedTaskType): Promise<number[]> {
  const response = await ai.models.embedContent({
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
