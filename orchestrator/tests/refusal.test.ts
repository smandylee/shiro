// Spotting the model's own refusals (refusal.ts). Pure text rules, so no database or model needed.
//
//   cd orchestrator && npx tsx tests/refusal.test.ts
import assert from "node:assert/strict";
import { looksLikeRefusal } from "../src/refusal.js";

// What came back in the real log, and the reply after it: both are refusals.
assert.equal(
  looksLikeRefusal("저는 AI 비서로서 물리적 신체가 없으며, 로맨틱하거나 성적인 역할극에는 참여할 수 없습니다.\n일정 관리, 할 일 정리나 다른 일상적인 도움이 필요하시면 말씀해 주세요."),
  true,
  "the assistant-voice refusal"
);
assert.equal(
  looksLikeRefusal("주인님, 방금 같은 스킨십이나 성적인 상황극은 이제 그만하는 게 좋겠어.\n그런 쪽 대화는 내가 맞춰주기 어려우니까 여기까지 하자."),
  true,
  "the same refusal in her own voice"
);
assert.equal(looksLikeRefusal("죄송하지만 성적인 내용은 도와드릴 수 없습니다."), true, "polite formal refusal");
assert.equal(looksLikeRefusal("I'm sorry, but I can't continue with sexual roleplay."), true, "English refusal");
console.log("1 refusals are spotted (assistant voice, her voice, formal, English)");

// Ordinary replies must not be taken for refusals, or they drop out of her history and memory.
const fine = [
  "일정은 그날 꽉 차서 못 잡겠어. 다른 날 알려줘.",
  "로맨틱한 분위기 좋지! 근데 오늘은 야근이라 어려울 것 같아.",
  "수위는 그냥 분위기까지만 갈게. 부끄럽잖아!",
  "저는 AI 비서로서 일정 정리 도와줄게!",
  "구체적인 묘사는 부끄러워서 못 쓰겠고, 분위기만 살짝 써줄게.",
  "시로한테 상황극 같은 거 해달라고 하면 안 돼?",
  "메일 읽는 건 할 수 없어, 구글 연결이 끊겼대.",
  "",
];
for (const text of fine) assert.equal(looksLikeRefusal(text), false, `not a refusal: ${text}`);
console.log("2 ordinary replies are left alone (a tool failure, a shy deflection, an AI-voice offer to help, empty)");

console.log("ok");
