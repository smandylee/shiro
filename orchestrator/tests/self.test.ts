// Shiro's own notes (memory/self.ts) and how a night's proposal is applied (memory/self-learn.ts):
// limits, the owner's lines left alone, refusals kept out, nothing shown until switched on.
// Needs a working better-sqlite3; point SHIRO_DB_PATH at a scratch file that does not exist yet.
//
//   cd orchestrator && rm -f /tmp/self-test.sqlite* && SHIRO_DB_PATH=/tmp/self-test.sqlite npx tsx tests/self.test.ts
import assert from "node:assert/strict";

process.env.GOOGLE_CLOUD_PROJECT ??= "test-project"; // self-learn.ts builds a client at import; nothing is called

const self = await import("../src/memory/self.js");
const { applySelf } = await import("../src/memory/self-learn.js");
const { db } = await import("../src/memory/db.js");

const empty = { adds: 4, changes: 8 };
const none = { add: [], update: [], remove: [], diary: "" };

// 1 nothing is shown, and nothing runs, until it is switched on
assert.equal(self.selfNotesOn(), false);
assert.equal(self.renderSelf(), "");
self.setSelfNotesOn(true);
assert.equal(self.selfNotesOn(), true);
self.setSelfNotesOn(false);
assert.equal(self.selfNotesOn(), false);
console.log("1 off until switched on");

// 2 notes: clean, dedupe, kinds, cap
const a = self.addNote("taste", "  나는 참치 통조림이 \n 제일 좋아  ", "learned");
assert.ok(a);
assert.equal(self.getNote(a!)!.text, "나는 참치 통조림이 제일 좋아", "one line, no stray whitespace");
assert.equal(self.addNote("taste", "나는 참치 통조림이 제일 좋아", "learned"), null, "the same line twice");
assert.equal(self.addNote("nope" as never, "x", "learned"), null, "unknown kind");
assert.equal(self.addNote("habit", "   ", "learned"), null, "empty");
assert.equal(self.cleanNote("가".repeat(500)).length, self.MAX_NOTE_LENGTH);
for (let i = 0; self.listNotes().length < self.MAX_NOTES; i++) self.addNote("bond", `농담 ${i}`, "learned");
assert.equal(self.addNote("bond", "하나 더", "learned"), null, "full");
for (const n of self.listNotes()) if (n.id !== a) self.removeNote(n.id);
assert.equal(self.listNotes().length, 1);
console.log("2 notes: one line, no duplicates, known kinds, capped");

// 3 rendering: grouped, the diary only while it is recent
self.addNote("habit", "주인님이 늦게 자면 한마디 한다", "learned");
self.addNote("bond", "주인님을 '세미콜론 장인'이라고 부른다", "learned");
const now = Date.now();
self.setDiary("요즘 주인님이 시험 공부로 바쁘다. 나는 간식이 줄어서 심술이 났다.", now);
const text = self.renderSelf(now);
assert.match(text, /취향과 의견:\n- 나는 참치/);
assert.match(text, /습관과 말버릇:\n- 주인님이 늦게/);
assert.match(text, /주인님과 나 사이:\n- 주인님을 '세미콜론/);
assert.match(text, /요즘 \(/);
assert.doesNotMatch(self.renderSelf(now + 6 * 24 * 3600e3), /요즘/, "an old diary is left out");
assert.match(self.renderSelfNumbered(), /^\[취향과 의견\]\n\d+\. /);
console.log("3 rendering: grouped by kind, a stale diary dropped");

// 4 applying a night's proposal
const habit = self.listNotes().find((n) => n.kind === "habit")!;
const mine = self.addNote("taste", "나는 비 오는 날이 좋아", "owner")!;
const before = self.listNotes().length;

assert.equal(applySelf(none, empty, now), "nothing new");
assert.equal(self.listNotes().length, before, "nothing proposed, nothing changed");

const summary = applySelf(
  {
    add: [
      { kind: "taste", text: "나는 낮잠 자리를 직접 고른다" },
      { kind: "habit", text: "저는 AI 비서로서 도와드릴 수 없습니다" }, // a disclaimer is not who she is
      { kind: "bond", text: "죄송하지만 성적인 내용은 도와드릴 수 없습니다" }, // nor is a refusal
      { kind: "habit", text: "가" },
      { kind: "habit", text: "나" },
      { kind: "habit", text: "다" },
    ],
    update: [
      { id: habit.id, text: "주인님이 늦게 자면 두 번은 말하고 만다" },
      { id: mine, text: "주인님이 고친 줄을 시로가 바꾸려 한다" }, // the owner's line is not hers to rewrite
    ],
    remove: [mine, 99999],
    diary: "",
  },
  empty,
  now
);
// Adds are cut to the first four proposed (the real line, two it then rejects, one letter).
assert.match(summary, /^\+2 ~1 -0/, summary);
assert.equal(self.getNote(habit.id)!.text, "주인님이 늦게 자면 두 번은 말하고 만다");
assert.equal(self.getNote(mine)!.text, "나는 비 오는 날이 좋아", "the owner's line is untouched");
assert.ok(!self.listNotes().some((n) => /AI 비서|성적인/.test(n.text)), "no disclaimer or refusal kept");
console.log("4 apply: capped, owner's lines and refusals kept out");

// 5 every rewrite can be undone
const snaps = db.prepare("SELECT notes_json FROM self_snapshots ORDER BY id DESC").all() as { notes_json: string }[];
assert.ok(snaps.length >= 1);
const last = JSON.parse(snaps[0].notes_json) as { notes: { id: number; text: string }[]; diary: unknown };
assert.ok(last.notes.some((n) => n.id === habit.id && n.text === "주인님이 늦게 자면 한마디 한다"), "the snapshot holds the line as it was");
console.log("5 snapshot: the notes as they were before the rewrite");

console.log("ok");
