import { ai } from "../llm/client.js";
import { recordUsage } from "../memory/usage.js";

const MODEL = "gemini-3.7-flash";
const MAX_RESULT_CHARS = 4000;

// Google Search / URL grounding only works as a tool of a model call, so the
// lookup is its own call (like look_up_namuwiki). Keeping it out of the main
// chat call means an ordinary message no longer pays for grounding — its
// latency tail measured 16-75s in some runs — and only questions that need the
// web wait for it.
export async function searchWeb(query: string, url?: string): Promise<string> {
  const target = url
    ? `다음 주소의 페이지를 실제로 읽고 답해줘: ${url}\n`
    : `구글 검색으로 찾아서, 나온 페이지를 실제로 읽고 답해줘.\n`;

  const prompt = `${target}
질문/검색어: ${query}

규칙:
- 검색 결과 스니펫만 보고 답하지 말고, 필요하면 페이지를 열어서 읽는다.
- 읽은 내용만 쓴다. 기억이나 추측으로 채우지 않는다. 최신 정보가 필요한 질문이면 날짜를 확인한다.
- 못 찾았거나 확실하지 않으면 "못 찾음" / "확실하지 않음"이라고 분명히 말한다.
- 한국어로, 사실 위주로 간결하게. 캐릭터 연기나 말투 없이 정보만 전달한다.
- 마지막 줄에 참고한 출처(사이트 이름이나 주소)를 적는다.`;

  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { tools: [{ googleSearch: {} }, { urlContext: {} }] },
  });

  const u = res.usageMetadata;
  recordUsage("websearch", {
    input: u?.promptTokenCount ?? 0,
    output: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
    cached: u?.cachedContentTokenCount ?? 0,
  });

  const text = res.text?.trim();
  if (!text) return "검색해봤는데 결과를 못 받았어.";

  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n...(내용이 길어서 여기까지)`
    : text;
}
