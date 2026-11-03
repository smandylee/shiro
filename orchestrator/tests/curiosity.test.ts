// When a question may be asked: not before the thing has happened, not once it has gone stale.
// Needs a working better-sqlite3; point SHIRO_DB_PATH at a scratch file.
//
//   cd orchestrator && SHIRO_DB_PATH=/tmp/curiosity-test.sqlite npx tsx tests/curiosity.test.ts
import assert from "node:assert/strict";
import { parseLocalTime } from "../src/memory/localtime.js";

const H = 3600e3, D = 24 * H;

// reading the model's wall-clock times
assert.equal(parseLocalTime("2026-11-04 15:00", "Asia/Hong_Kong"), Date.UTC(2026, 10, 4, 7, 0));
assert.equal(parseLocalTime("2026-11-04", "Asia/Hong_Kong"), Date.UTC(2026, 10, 3, 16, 0), "a bare date is the start of that day");
assert.equal(parseLocalTime("2026-11-04T09:30", "Asia/Seoul"), Date.UTC(2026, 10, 4, 0, 30));
assert.equal(parseLocalTime("2026-07-01 12:00", "Europe/London"), Date.UTC(2026, 6, 1, 11, 0), "summer time");
assert.equal(parseLocalTime("2026-12-01 12:00", "Europe/London"), Date.UTC(2026, 11, 1, 12, 0), "winter time");
for (const bad of ["", "내일", "2026-02-30 10:00", "2026-11-04 25:00", null, 42]) assert.equal(parseLocalTime(bad, "Asia/Hong_Kong"), null, String(bad));
console.log("1 wall-clock times: zones, summer time, and junk is null");

const { addCuriosity, askableCuriosities, markAsked, markDropped, openCuriosities } = await import("../src/memory/curiosity.js");
const now = Date.now();
for (const c of openCuriosities()) markDropped(c.id); // a clean slate in a reused scratch file

assert.ok(addCuriosity("새 키보드는 마음에 드는지", "conversation"));
assert.ok(addCuriosity("시험은 잘 봤는지", "conversation", { askAfter: now + 5 * H, expiresAt: now + 3 * D }));
assert.ok(addCuriosity("여행 다녀와서 어땠는지", "conversation", { askAfter: now + 10 * D }));
assert.equal(addCuriosity("어제 저녁 맛있었는지", "conversation", { expiresAt: now - H }), false, "already expired: not kept");
assert.equal(addCuriosity("모레 일", "conversation", { askAfter: now + 2 * D, expiresAt: now + D }), false, "expires before it may be asked");
assert.equal(addCuriosity("새 키보드는 마음에 드는지", "conversation"), false, "the same one twice");

assert.deepEqual(askableCuriosities(now).map((c) => c.text), ["새 키보드는 마음에 드는지"], "only the one with no wait");
assert.deepEqual(askableCuriosities(now + 6 * H).map((c) => c.text), ["시험은 잘 봤는지", "새 키보드는 마음에 드는지"], "after the exam: freshest first");
console.log("2 not before ask_after; newest first");

// expiry: the exam question is gone after 3 days; the no-time one after 7; the trip one survives
// its 10-day wait (expiry counts from when it becomes askable) and goes 7 days after that
assert.deepEqual(askableCuriosities(now + 4 * D).map((c) => c.text), ["새 키보드는 마음에 드는지"]);
assert.deepEqual(openCuriosities(now + 8 * D).map((c) => c.text), ["여행 다녀와서 어땠는지"], "8 days on: only the trip question is still waiting");
assert.deepEqual(askableCuriosities(now + 11 * D).map((c) => c.text), ["여행 다녀와서 어땠는지"]);
assert.deepEqual(openCuriosities(now + 18 * D), []);
console.log("3 expiry, and a far-off question is not dropped as old while it waits");

// asked and dropped ones leave the list
assert.ok(addCuriosity("점심 뭐 먹었는지", "conversation"));
assert.ok(addCuriosity("주말에 뭐 하는지", "spontaneous"));
const [a, b] = askableCuriosities();
markAsked(a.id);
markDropped(b.id);
assert.ok(!askableCuriosities().some((c) => c.id === a.id || c.id === b.id));
assert.equal(addCuriosity(a.text, "conversation"), false, "just asked: not noted again");
console.log("all curiosity tests passed");
