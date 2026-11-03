// Noticing when the owner's day starts (wake.ts), from the devices they connect to Discord on and
// from their messages. Needs a working better-sqlite3 (the settings table); point SHIRO_DB_PATH
// at a scratch file.
//
//   cd orchestrator && SHIRO_DB_PATH=/tmp/wake-test.sqlite npx tsx tests/wake.test.ts
import assert from "node:assert/strict";
import { connectedDevices, isWake, newDevices } from "../src/wake-core.js";

const H = 3600e3;
const cfg = { awayMs: 4 * H, dayStartHour: 5 };

// the pure rule
assert.deepEqual(connectedDevices({ desktop: "idle", mobile: "idle" }), ["desktop", "mobile"], "idle is still connected");
assert.deepEqual(connectedDevices({ desktop: "online", web: "offline" }), ["desktop"]);
assert.deepEqual(connectedDevices(null), []);
assert.deepEqual(newDevices(["desktop"], ["desktop", "mobile"]), ["mobile"]);
assert.deepEqual(newDevices(["desktop", "mobile"], ["desktop"]), []);
assert.equal(isWake(0, 8 * H, 9, cfg), true, "back after 8 hours in the morning");
assert.equal(isWake(0, 3 * H, 9, cfg), false, "away 3 hours is not a night");
assert.equal(isWake(0, 8 * H, 3, cfg), false, "3 a.m. is a late night, not a morning");
assert.equal(isWake(null, 0, 14, cfg), true, "no record at all: any appearance in the day counts");
console.log("1 the rule: devices (idle counts as connected), the four-hour absence, the 5 a.m. line");

// the tracker, through a few days (Hong Kong time = UTC+8). The owner is always set to idle.
const { ownerDevicesChanged, ownerMessaged, wokeToday } = await import("../src/wake.js");
const hk = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h - 8, m);
const none: string[] = [], pc = ["desktop"], phone = ["mobile"], both = ["desktop", "mobile"];

// day 1: up late on the PC; everything off at 02:30; the phone opens Discord at 11:10
assert.equal(ownerDevicesChanged(none, pc, hk(1, 22)), true, "first ever sighting in the day counts");
assert.equal(ownerMessaged(hk(2, 1, 50)), false, "still up after midnight");
assert.equal(ownerDevicesChanged(pc, none, hk(2, 2, 30)), false);
assert.equal(wokeToday(hk(2, 9)), false, "day 2 has not started at 9 while they sleep");
assert.equal(ownerDevicesChanged(none, phone, hk(2, 11, 10)), true, "phone opens at 11:10 after 8.7 h: the day starts");
assert.equal(wokeToday(hk(2, 11, 15)), true);
console.log("2 a late night, then the phone at 11:10");

// the same day: more devices and a long afternoon away do not start it again
assert.equal(ownerDevicesChanged(phone, both, hk(2, 12)), false);
assert.equal(ownerDevicesChanged(both, none, hk(2, 13)), false);
assert.equal(ownerDevicesChanged(none, pc, hk(2, 19)), false, "6 hours out, but the day has already started");
// the presence event arrives once per shared server: the copy changes nothing
assert.equal(ownerDevicesChanged(none, pc, hk(2, 19)), false);
console.log("3 one start per day, whatever happens later");

// day 3: the PC stays connected all night (idle), sending nothing; the phone opens at 9:40
assert.equal(ownerMessaged(hk(3, 0, 30)), false, "last message 00:30");
assert.equal(ownerDevicesChanged(pc, both, hk(3, 9, 40)), true, "phone appears beside the overnight PC after 9 h");
console.log("4 PC left on overnight: the phone shows they are up");

// day 4: PC on all night, no phone; the first message at 14:05 starts the day
assert.equal(ownerDevicesChanged(both, pc, hk(3, 23)), false, "phone closes at 23:00");
assert.equal(ownerMessaged(hk(4, 14, 5)), true, "a first message after 15 h starts the day");
assert.equal(ownerMessaged(hk(4, 14, 6)), false);
console.log("5 nothing but the PC: the first message starts the day");

// day 5: a phone check at 4 a.m. is a late night; the one at 10 starts the day
assert.equal(ownerDevicesChanged(pc, both, hk(5, 4)), false, "4 a.m.");
assert.equal(ownerDevicesChanged(both, pc, hk(5, 4, 5)), false);
assert.equal(ownerDevicesChanged(pc, both, hk(5, 10)), true, "10:00, 6 h after the 4 a.m. check");
console.log("6 a 4 a.m. glance does not count, and moves the night along");

assert.equal(wokeToday(hk(5, 11)), true);
console.log("all wake tests passed");
