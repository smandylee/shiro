const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;

if (!GATEWAY_TOKEN) {
  console.warn("[openclaw] OPENCLAW_GATEWAY_TOKEN not set — command execution disabled.");
}

const EXEC_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 3000;

async function askGateway(prompt: string, sessionKey: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXEC_TIMEOUT_MS);

  try {
    const response = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openclaw/default",
        user: sessionKey,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`openclaw request failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const result = data.choices?.[0]?.message?.content;
    if (!result) {
      throw new Error(`openclaw returned empty content: ${JSON.stringify(data)}`);
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Runs one already-approved shell command. The command text is fixed by the
 * time this is called — the prompt only asks for it to be run verbatim, so the
 * agent has no room to reinterpret what the owner approved.
 */
export async function runApprovedCommand(command: string): Promise<string> {
  if (!GATEWAY_TOKEN) {
    return "(오픈클로 연결이 안 되어 있어서 명령을 실행할 수 없어)";
  }

  const prompt = `아래 명령을 **그대로** 한 번만 실행하고 결과를 보고해줘.

명령:
\`\`\`
${command}
\`\`\`

규칙:
- 명령을 수정하거나 다른 명령으로 바꾸지 않는다. 적힌 그대로 실행한다.
- 추가로 다른 작업을 하지 않는다. 이 명령 하나만 실행한다.
- 표준 출력과 표준 에러를 그대로 보여준다. 실패하면 실패했다고 분명히 말한다.
- 결과를 꾸미거나 지어내지 않는다. 실제 출력만 전달한다.`;

  const out = await askGateway(prompt, `shiro:exec:${Date.now()}`);
  return out.length > MAX_OUTPUT_CHARS
    ? `${out.slice(0, MAX_OUTPUT_CHARS)}\n...(출력이 길어서 여기까지)`
    : out;
}
