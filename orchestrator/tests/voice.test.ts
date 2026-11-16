// What is sent to the voice: Korean chat shorthand turned into tags and words (tts/perform.ts),
// the emotion tags, and each line of a reply being given the line before it (avatar/speak.ts).
// No network and no database: the synthesizer is a stand-in.
//
//   cd orchestrator && npx tsx tests/voice.test.ts
import assert from "node:assert/strict";
import { toPerformedText } from "../src/tts/perform.js";
import { TAGS } from "../src/tts/elevenlabs.js";
import { EMOTIONS } from "../src/persona.js";
import { ReplyVoice, type VoiceDeps } from "../src/avatar/speak.js";
import { cleanCue, readLineMarks, stripMarks, dialogueOnly, showNarrationSmall } from "../src/tts/marks.js";
import { StreamedReply } from "../src/reply.js";

// 1 sounds typed as letters become tags
const cases: [string, string][] = [
  ["ㅋㅋㅋ 진짜?", "[laughs] 진짜?"],
  ["아ㅋㅋ 그게 뭐야", "아 [laughs] 그게 뭐야"],
  ["ㅎㅎ 고마워", "[laughs softly] 고마워"],
  ["ㅠㅠ 미안해", "[crying] 미안해"],
  ["그래ㅡㅡ 알겠어", "그래 [sighs] 알겠어"],
  ["주인님^^ 왔어?", "주인님 왔어?"],
];
for (const [input, want] of cases) assert.equal(toPerformedText(input), want, input);
console.log("1 ㅋㅋ ㅎㅎ ㅠㅠ ㅡㅡ ^^ become tags or nothing");

// 2 shorthand that is a word is said as the word, but only when it stands alone
assert.equal(toPerformedText("ㅇㅇ 알겠어"), "응응 알겠어");
assert.equal(toPerformedText("ㅇㅋ ㄱㄱ"), "오케이 고고");
assert.equal(toPerformedText("ㄴㄴ 아니야"), "노노 아니야");
assert.equal(toPerformedText("응ㅇㅇ"), "응", "inside a word it is not shorthand; the stray letters are dropped");
console.log("2 ㅇㅇ ㅇㅋ ㄱㄱ ㄴㄴ are spoken as words");

// 3 pauses and leftovers
assert.equal(toPerformedText("음…… 글쎄"), "음... 글쎄");
assert.equal(toPerformedText("음......... 글쎄"), "음... 글쎄");
assert.equal(toPerformedText("ㅋ"), "", "one stray letter leaves nothing to say");
assert.equal(toPerformedText("ㅜ"), "");
console.log("3 ellipses are normalised, stray letters are dropped");

// 4 ordinary sentences are left exactly as they are
for (const plain of ["오늘 일정은 두 개야!", "9월 1일은 08:30~10:20 수업이야.", "주인님, 밥은 먹었어?", "...어디를 그렇게 쳐다보는 거야."]) {
  assert.equal(toPerformedText(plain), plain, plain);
}
console.log("4 normal sentences are untouched");

// 5 every emotion has a tag, each one cue in square brackets
for (const e of EMOTIONS) {
  if (e === "neutral") assert.equal(TAGS[e], undefined, "neutral is left to the voice");
  else assert.match(TAGS[e] ?? "", /^\[[a-z ,]+\]$/, e);
}
console.log("5 every feeling but neutral has one bracketed tag");

// 6 each line is voiced knowing the one before it
const calls: { line: string; previousText?: string }[] = [];
const deps: VoiceDeps = {
  synth: async (line, _emotion, _signal, context) => {
    calls.push({ line, previousText: context?.previousText });
    return (async function* () {
      yield Buffer.from("x");
    })();
  },
  send: () => {},
};
const voice = new ReplyVoice("t", "happy", deps);
voice.addLine("첫 줄이야.");
voice.addLine("둘째 줄이야.");
voice.addLine("셋째 줄이야.");
await voice.end();
const byLine = new Map(calls.map((c) => [c.line, c.previousText]));
assert.equal(byLine.get("첫 줄이야."), undefined, "the first line has nothing before it");
assert.equal(byLine.get("둘째 줄이야."), "첫 줄이야.");
assert.equal(byLine.get("셋째 줄이야."), "둘째 줄이야.");
console.log("6 a line is given the one before it");

// 7 cues: only short English, anything else is not a cue
assert.equal(cleanCue("Whispering, Shy"), "whispering, shy");
assert.equal(cleanCue("  teasing  "), "teasing");
for (const bad of ["", "   ", "속삭이듯", "whispering] [angry", "a".repeat(41), "123", "shy!"]) assert.equal(cleanCue(bad), null, bad);
console.log("7 cues: short English words only");

// 8 reading the marks in a line
assert.deepEqual(readLineMarks("그냥 한 줄이야."), { line: "그냥 한 줄이야." });
assert.deepEqual(readLineMarks("[emotion:love]하앙... 가만히 있어."), { line: "하앙... 가만히 있어.", emotion: "love", cue: null });
assert.deepEqual(readLineMarks("[emotion:love][voice:whispering, shy]하앙..."), {
  line: "하앙...",
  emotion: "love",
  cue: "whispering, shy",
});
assert.deepEqual(readLineMarks("[voice:teasing]어머, 진짜?"), { line: "어머, 진짜?", cue: "teasing" });
assert.deepEqual(readLineMarks("[voice:속삭이듯]응."), { line: "응.", cue: null }, "a bad cue clears the cue");
assert.deepEqual(readLineMarks("[emotion:nonsense]응."), { line: "응." }, "an unknown feeling is removed, not obeyed");
assert.equal(stripMarks("[emotion:love]자꾸 쳐다보면...[voice:warm] 안 놔둘 거야."), "자꾸 쳐다보면...안 놔둘 거야.");
console.log("8 marks are read, applied by order, and removed");

// 9 the feeling and cue reach the voice line by line
const how: { line: string; emotion: string; cue?: string }[] = [];
const deps2: VoiceDeps = {
  synth: async (line, emotion, _s, context) => {
    how.push({ line, emotion, cue: context?.cue });
    return (async function* () {
      yield Buffer.from("x");
    })();
  },
  send: () => {},
};
const v2 = new ReplyVoice("t2", "embarrassed", deps2);
v2.addLine("어, 아닌데...");
v2.addLine("그래도 좋아.", { emotion: "love", cue: "whispering, shy" });
v2.addLine("...진짜야.", { emotion: "love", cue: null });
await v2.end();
const h = new Map(how.map((x) => [x.line, x]));
assert.deepEqual(h.get("어, 아닌데..."), { line: "어, 아닌데...", emotion: "embarrassed", cue: undefined });
assert.deepEqual(h.get("그래도 좋아."), { line: "그래도 좋아.", emotion: "love", cue: "whispering, shy" });
assert.deepEqual(h.get("...진짜야."), { line: "...진짜야.", emotion: "love", cue: undefined });
console.log("9 each line carries its own feeling and cue");

// 10 a streamed reply: marks are carried out of the text, never shown in Discord
const shown: string[] = [];
const streamed = new StreamedReply(async (line) => {
  shown.push(line);
});
for (const piece of ["[emotion:embarrassed][voice:shy]어, 아", "닌데...\n[emotion:lo", "ve]그래도 좋아.[voice:warm]\n끝"]) streamed.push(piece);
await streamed.finish();
assert.deepEqual(shown, ["어, 아닌데...", "그래도 좋아.", "끝"]);
console.log("10 the chat never shows a mark, even one split across pieces");

// 11 narrated channel: only the "quoted" dialogue is voiced, the narration is for reading
assert.equal(dialogueOnly("시로는 창밖을 보다가 고개를 돌린다."), "", "pure narration says nothing");
assert.equal(dialogueOnly('"왔어?" 시로가 귀를 쫑긋 세운다. "기다렸어."'), "왔어? 기다렸어.");
assert.equal(dialogueOnly("“왔어?”"), "왔어?", "curly quotes work too");
assert.equal(dialogueOnly('**"나야. 문 열어."**'), "나야. 문 열어.", "bold quotes: the asterisks are not said");
assert.equal(dialogueOnly('꼬리가 흔들린다. "응, 나 여기 있어.'), "응, 나 여기 있어.", "a quote left open runs to the end of the line");
assert.equal(dialogueOnly('그는 "안녕"이라고 말했다.'), "안녕");
const shownNarrated: string[] = [];
const narrated = new StreamedReply(async (line) => {
  shownNarrated.push(line);
}, true);
for (const piece of ["[emotion:love]시로는 창밖을 보다가 고개를 돌린다.\n\"왔어", "? 기다렸어.\"\n"]) narrated.push(piece);
await narrated.finish();
assert.deepEqual(shownNarrated, ["시로는 창밖을 보다가 고개를 돌린다.", '"왔어? 기다렸어."'], "the chat shows narration and dialogue");
console.log("11 the whole story is shown in the chat, only the quoted lines are voiced");

// 12 in Discord, narration is small grey subtext; a line with dialogue is left as it is
assert.equal(showNarrationSmall("시로는 창밖을 보다가 고개를 돌렸다."), "-# 시로는 창밖을 보다가 고개를 돌렸다.");
assert.equal(showNarrationSmall('"왔어? 기다렸어."'), '"왔어? 기다렸어."');
assert.equal(showNarrationSmall('시로가 웃었다. "왔어?"'), '시로가 웃었다. "왔어?"', "a line with both stays normal");
console.log("12 narration lines are shown as small grey subtext, dialogue lines as they are");

console.log("ok");
