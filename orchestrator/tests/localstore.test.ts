// Long-term memory in her own database: storing, finding, importing twice, surviving a restart.
// Uses a database of its own (SHIRO_DB_PATH), never the real one.
//
//   cd orchestrator && npx tsx tests/localstore.test.ts
//
// Needs a working better-sqlite3 (it does not load on macOS 13.0 here; run it on Linux or Windows).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SHIRO_DB_PATH = join(mkdtempSync(join(tmpdir(), "shiro-store-")), "t.sqlite");
const store = await import("../src/memory/localstore.js");

const unit = (i: number, n = 768) => Array.from({ length: n }, (_, k) => (k === i ? 1 : 0));
const mem = (id: string, i: number, text: string) => ({ id, speaker: "주인님", userText: text, assistantText: `답: ${text}`, createdAt: 1_000 + i, vector: unit(i) });

assert.equal(store.memoryCount(), 0);
assert.equal(store.searchMemories(unit(0), 5, 0).length, 0, "an empty memory finds nothing");

assert.equal(store.addMemory(mem("a", 0, "시험 얘기")), true);
assert.equal(store.addMemory(mem("b", 1, "저녁 메뉴")), true);
assert.equal(store.addMemory(mem("c", 2, "마크 계획")), true);
assert.equal(store.memoryCount(), 3);
console.log("1 stored three exchanges");

let found = store.searchMemories(unit(1), 5, 0.65);
assert.equal(found.length, 1); assert.equal(found[0].memory.id, "b"); assert.ok(Math.abs(found[0].score - 1) < 1e-6);
assert.equal(found[0].memory.userText, "저녁 메뉴"); assert.equal(found[0].memory.assistantText, "답: 저녁 메뉴"); assert.equal(found[0].memory.speaker, "주인님"); assert.equal(found[0].memory.createdAt, 1_001);
console.log("2 found by meaning, with the exact words, who said them and when");

// a vector the model scaled differently still finds the same thing
found = store.searchMemories(unit(2).map((x) => x * 40), 5, 0.65); assert.equal(found[0].memory.id, "c");
// a mix: both related, best first
const mix = unit(0).map((x, k) => x * 0.9 + unit(1)[k] * 0.4);
found = store.searchMemories(mix, 5, 0.3); assert.deepEqual(found.map((f) => f.memory.id), ["a", "b"]);
console.log("3 scale does not matter; related memories come back best first");

// importing the same thing twice changes nothing
assert.equal(store.addMemory(mem("a", 0, "시험 얘기")), false); assert.equal(store.memoryCount(), 3);
assert.throws(() => store.addMemory({ ...mem("x", 3, "빈 벡터"), vector: [] }), /vector/);
console.log("4 adding an id that exists is ignored; an empty vector is refused");

// a memory from a differently-sized embedding is not compared against
store.addMemory({ ...mem("short", 4, "다른 차원"), vector: [1, 0, 0] });
assert.equal(store.searchMemories(unit(0), 10, 0).every((f) => f.memory.id !== "short"), true); console.log("5 a vector of another size is skipped, not an error");

// what is written is what a fresh start reads back (a second copy of the module reads the same table)
const again = await import("../src/memory/localstore.js?restart");
assert.equal(again.memoryCount(), 4);
const back = again.searchMemories(unit(2), 5, 0.65); assert.equal(back[0].memory.id, "c"); assert.ok(Math.abs(back[0].score - 1) < 1e-6);
assert.equal(again.loadMemories(), 4);
console.log("6 a fresh start reads the same memories back from the table");
console.log("local store: ok");
