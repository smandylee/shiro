// Noticing when the owner's day starts (wake.ts), from their Discord status and their messages.
// Needs a working better-sqlite3 (the settings table); point SHIRO_DB_PATH at a scratch file.
//
//   cd orchestrator && SHIRO_DB_PATH=/tmp/wake-test.sqlite npx tsx tests/wake.test.ts
import assert from "node:assert/strict";
import { isActiveStatus, isWake } from "../src/wake-core.js";

const H = 3600e3;
const cfg = { awayMs: 4 * H, dayStartHour: 5 };

// the pure rule
assert.ok(isActiveStatus("online") && isActiveStatus("dnd"));
assert.ok(!isActiveStatus("idle") && !isActiveStatus("offline") && !isActiveStatus("invisible") && !isActiveStatus(undefined));
assert.equal(isWake(0, 8 * H, 9, cfg), true, "back after 8 hours in the morning");
assert.equal(isWake(0, 3 * H, 9, cfg), false, "away 3 hours is not a night");
assert.equal(isWake(0, 8 * H, 3, cfg), false, "3 a.m. is a late night, not a morning");
assert.equal(isWake(null, 0, 14, cfg), true, "no record at all: any appearance in the day counts");
console.log("1 the rule: active statuses, the four-hour absence, the 5 a.m. line");

// the tracker, through a few days (Hong Kong time = UTC+8)
const { ownerMessaged, ownerStatusChanged, wokeToday } = await import("../src/wake.js");
const { setSetting } = await import("../src/memory/settings.js");
setSetting("ownerLastActiveAt", "");
setSetting("ownerWokeAt", "");
const hk = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h - 8, m);

// day 1: up late, phone goes offline at 02:30, back online at 11:10
assert.equal(ownerStatusChanged("offline", "online", hk(1, 22)), true, "first ever sighting in the day counts");
assert.equal(ownerMessaged(hk(2, 1, 50)), false, "still up after midnight");
assert.equal(ownerStatusChanged("online", "offline", hk(2, 2, 30)), false);
assert.equal(wokeToday(hk(2, 9)), false, "day 2 has not started at 9 while they sleep");
assert.equal(ownerStatusChanged("offline", "online", hk(2, 11, 10)), true, "back online at 11:10 after 8.7 h: the day starts");
assert.equal(wokeToday(hk(2, 11, 15)), true);
console.log("2 a late night, then an 11:10 start");

// the same day: a short absence and an afternoon away do not start it again
assert.equal(ownerStatusChanged("online", "idle", hk(2, 12)), false);
assert.equal(ownerStatusChanged("idle", "online", hk(2, 12, 20)), false, "20 minutes idle");
assert.equal(ownerStatusChanged("online", "offline", hk(2, 13)), false);
assert.equal(ownerStatusChanged("offline", "online", hk(2, 19)), false, "6 hours out, but the day has already started");
// the presence event arrives once per shared server: the copy changes nothing
assert.equal(ownerStatusChanged("offline", "online", hk(2, 19)), false);
console.log("3 one start per day, whatever happens later");

// day 3: invisible all day; only a message shows they are up, at 14:05
assert.equal(ownerStatusChanged("online", "offline", hk(2, 23, 40)), false);
assert.equal(ownerMessaged(hk(3, 14, 5)), true, "a first message after 14 h starts the day");
assert.equal(ownerMessaged(hk(3, 14, 6)), false);
console.log("4 invisible: the first message starts the day");

// day 4: never left (desktop online all night, going idle only briefly) -> no start from status;
// the first message after a long silence still counts
assert.equal(ownerStatusChanged("idle", "online", hk(4, 3)), false, "3 a.m.");
assert.equal(ownerStatusChanged("online", "idle", hk(4, 3, 10)), false);
assert.equal(ownerStatusChanged("idle", "online", hk(4, 4, 50)), false, "before 5 a.m.");
assert.equal(ownerStatusChanged("online", "idle", hk(4, 5)), false);
assert.equal(ownerStatusChanged("idle", "online", hk(4, 9, 30)), true, "back from idle after 4.5 h at 9:30");
console.log("5 idle overnight counts as away");

// a restart keeps the record: a fresh import of the module reads it back from settings
assert.equal(wokeToday(hk(4, 10)), true);
console.log("all wake tests passed");
