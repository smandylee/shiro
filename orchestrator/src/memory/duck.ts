import { getSetting, setSetting } from "./settings.js";

// Rubber-duck mode: the owner talks something through out loud and she listens
// instead of answering. People often find their own answer while explaining a
// problem to someone who only asks what they meant — a verdict from her, however
// kind, ends that. So while it is on she hands the thinking back.
//
// It is switched on and off in conversation and lapses on its own: left on and
// forgotten, a listener that only ever asks questions is just tiring.

/** How long after the owner's last word it stays on. Every word from them renews it. */
export const DUCK_IDLE_MS = 90 * 60 * 1000;

const KEY = "duckUntil";

export function duckActive(now = Date.now()): boolean {
  try {
    return Number(getSetting(KEY) ?? 0) > now;
  } catch {
    return false;
  }
}

export function startDuck(now = Date.now()): void {
  setSetting(KEY, String(now + DUCK_IDLE_MS));
}

export function stopDuck(): void {
  setSetting(KEY, "0");
}

/** A word from the owner while it is on keeps it on; silence lets it lapse. */
export function keepDuck(now = Date.now()): void {
  try {
    if (duckActive(now)) startDuck(now);
  } catch (err) {
    // The mode must never be the reason an answer doesn't go out.
    console.error("[duck] could not renew:", err);
  }
}

/** What goes into her prompt while the mode is on, or "" when it is off. */
export function duckBlock(now = Date.now()): string {
  if (!duckActive(now)) return "";
  return (
    `\n\n[러버덕 모드 — 주인님이 생각이나 고민을 소리 내어 정리하려고 켰다. 지금 시로의 일은 답을 주는 게 아니라 들어주고 되묻는 것이다]\n` +
    `- 결론, 충고, 위로를 먼저 내놓지 않는다. 주인님이 한 말을 한 줄로 되돌려 주고(예: "그러니까 ○○ 때문에 ○○한 거네?"), 질문 하나로 더 파고들게 한다. 질문은 한 번에 하나만.\n` +
    `- 질문은 주인님이 스스로 답을 찾게 하는 것으로: "그게 언제부터야?", "그럴 때 뭐가 제일 싫어?", "다른 때랑 뭐가 달라?", "진짜 원하는 건 뭐야?". 정답을 아는 척 가르치지 않는다.\n` +
    `- 주인님이 스스로 뭔가 깨달은 듯하면 그걸 짚어서 한 줄로 정리해 준다. 깨달은 걸 시로가 먼저 말해 버리지 않는다.\n` +
    `- 주인님이 "그냥 얘기해줘", "의견 줘", "힌트 줘"라고 하면 그때는 평소처럼 의견을 말한다.\n` +
    `- 평소 말투(반말, 짧게)는 유지하되 장난은 줄이고 차분하게 듣는다. 힘든 이야기는 가볍게 받아넘기지 않는다.\n` +
    `- 이 모드에서는 질문이 시로의 일이다. 위의 "습관적인 되묻기를 붙이지 않는다"는 규칙은 여기서는 적용하지 않는다. 질문 말고 다른 군더더기(다짐, 요약 반복)는 계속 붙이지 않는다.\n` +
    `- 일정·메일·할 일 같은 실제 요청이 섞여 오면 모드와 상관없이 평소처럼 처리한다.\n` +
    `- 주인님이 "러버덕 그만", "됐어", "이제 평소처럼"이라고 하면 set_duck_mode 도구로 끈다.`
  );
}
