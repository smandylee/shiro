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

console.log("ok");
