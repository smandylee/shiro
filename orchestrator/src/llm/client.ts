import { GoogleGenAI } from "@google/genai";

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION ?? "global";

if (!project) {
  throw new Error("GOOGLE_CLOUD_PROJECT is not set");
}

export const ai = new GoogleGenAI({ vertexai: true, project, location });
