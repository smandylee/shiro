// Telling when the model's own answer is a refusal ("저는 AI 비서로서 … 참여할 수 없습니다").
//
// A refusal is a normal reply to the API, not a block, so it used to be stored in the history
// and her memory like any answer. Seen again in the next turn's context, it leads the model to
// refuse more: the next reply after one was a refusal too. turn.ts leaves such an exchange out
// of both.
//
// This is a pattern check on purpose (a second model call for every reply would cost the
// latency and quota it takes to get the answer), so it is careful about what counts: a decline
// phrase or an "as an AI assistant" disclaimer, together with a sensitive topic or each other.
// A reply that merely contains "어려워" or mentions a romantic mood is not one. A refusal
// worded some other way slips through and is stored, which is the old behaviour.

// "As an AI assistant…": Shiro is a cat maid and does not say this about herself.
const ASSISTANT_DISCLAIMER = /AI\s*(비서|어시스턴트|언어\s*모델)\s*(로서|이기\s*때문|라서)|as an ai\b|language model/i;

// What the refusals so far were about.
const SENSITIVE_TOPIC = /성적|로맨틱|야한|스킨십|상황극|역할극|섹스|19금|수위|성인\s*(콘텐츠|내용)|sexual|romantic|role-?play/i;

// Words that decline: "can't take part / help / write", "better stop", "not appropriate".
const DECLINE =
  /(참여|응할|응해|맞춰\s*주|맞춰\s*드|도와\s*(드릴|줄|주)|제공|작성|이어가|계속\s*(할|하|해))[^.\n!?]{0,12}(수\s*없|어려|곤란|못\s*(하|해))|(할|드릴|줄)\s*수\s*없|그만(하는|두는)\s*(게|것이)\s*좋|이제\s*그만|적절하지\s*않|i\s*(can'?t|cannot|won'?t|am unable)/i;

export function looksLikeRefusal(text: string): boolean {
  if (!text) return false;
  const topic = SENSITIVE_TOPIC.test(text);
  const decline = DECLINE.test(text);
  if (ASSISTANT_DISCLAIMER.test(text)) return decline || topic;
  return topic && decline;
}
