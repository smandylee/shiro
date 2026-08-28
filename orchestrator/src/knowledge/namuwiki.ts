import { ai } from "../llm/client.js";
import { recordUsage } from "../memory/usage.js";

const MODEL = "gemini-3.7-flash";
const MAX_RESULT_CHARS = 4000;

// namu.wiki blocks direct scraping from our VM (Cloudflare 403), but Google's
// own fetcher gets through — so the lookup runs as a separate grounded model
// call rather than an HTTP request we make ourselves.
export async function lookUpNamuWiki(topic: string, question?: string): Promise<string> {
  const focus = question
    ? `특히 다음 질문에 답이 되는 내용을 찾아줘: ${question}`
    : `그 항목의 핵심 내용을 정리해줘.`;

  const prompt = `나무위키(namu.wiki)에서 "${topic}"에 대해 찾아보고 사실 정보를 정리해줘.

${focus}

규칙:
- 먼저 site:namu.wiki 로 검색해서 알맞은 문서를 찾고, 그 문서를 실제로 읽고 답한다.
- 나무위키는 문서가 잘게 나뉘어 있다. 찾는 내용이 하위 문서에 있으면(예: "Limbus Company/전투") 그 하위 문서까지 읽는다.
- 문서에서 실제로 읽은 내용만 쓴다. 기억이나 추측으로 채우지 않는다.
- 같은 이름의 다른 작품/게임 항목과 헷갈리지 않게, 반드시 ${topic}에 해당하는 문서인지 확인한다.
- 문서를 못 찾았거나 내용이 없으면 "나무위키에서 못 찾음"이라고 분명히 말한다.
- 한국어로, 사실 위주로 간결하게. 캐릭터 연기나 말투 없이 정보만 전달한다.
- 마지막 줄에 참고한 문서 제목을 적는다.`;

  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { tools: [{ googleSearch: {} }, { urlContext: {} }] },
  });

  const u = res.usageMetadata;
  recordUsage("namuwiki", {
    input: u?.promptTokenCount ?? 0,
    output: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
    cached: u?.cachedContentTokenCount ?? 0,
  });

  const text = res.text?.trim();
  if (!text) return "나무위키를 찾아봤는데 결과를 못 받았어.";

  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n...(내용이 길어서 여기까지)`
    : text;
}
