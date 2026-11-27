// The current time and the day marks on the history (clock.ts). No database, no network.
//
//   cd orchestrator && npx tsx tests/clock.test.ts
import assert from "node:assert/strict";
import { markDays, nowText, stampText } from "../src/clock.js";

const HK = "Asia/Hong_Kong";
const hk = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h - 8, m);

assert.equal(nowText(hk(27, 12, 5), HK), "2026년 11월 27일 금요일 오후 12:05");
assert.equal(stampText(hk(26, 23, 10), HK), "11월 26일 (목) 오후 11:10");
assert.equal(stampText(hk(27, 0, 30), HK), "11월 27일 (금) 오전 12:30", "just after midnight is the new day");
console.log("1 the time in words, in Hong Kong time");

const turns = [
  { role: "user" as const, text: "내일 오후 3시에 시험이야", at: hk(26, 23, 10) },
  { role: "model" as const, text: "헉 화이팅", at: hk(26, 23, 11) },
  { role: "user" as const, text: "자러 간다", at: hk(26, 23, 40) },
  { role: "model" as const, text: "잘 자", at: hk(26, 23, 41) },
  { role: "user" as const, text: "일어났다", at: hk(27, 9, 0) },
  { role: "model" as const, text: "좋은 아침", at: hk(27, 9, 1) },
  { role: "user" as const, text: "점심 뭐 먹지", at: hk(27, 9, 30) },
  { role: "user" as const, text: "수업 끝났다", at: hk(27, 13, 0) },
];
const marked = markDays(turns, HK).map((t) => t.text);
assert.deepEqual(marked, [
  "[11월 26일 (목) 오후 11:10] 내일 오후 3시에 시험이야",
  "헉 화이팅",
  "자러 간다",
  "잘 자",
  "[11월 27일 (금) 오전 9:00] 일어났다",
  "좋은 아침",
  "점심 뭐 먹지",
  "[11월 27일 (금) 오후 1:00] 수업 끝났다",
]);
assert.deepEqual(markDays([], HK), []);
assert.ok(!("at" in markDays(turns, HK)[0]), "only role and text go to the model");
console.log("2 marks: the first turn, a new day, a gap of 3 hours; nothing else, and never on her own lines");
console.log("all clock tests passed");
