// Staying alive, without asking anyone.
//
// None of this waits for a decision. Eating, running, hitting back and going to
// bed all happen in code, on the tick, because a round trip to Hong Kong and
// back through a language model is far too slow to survive a creeper. The
// planner decides what she is *doing*; this decides whether she is still alive
// to do it.
//
// Reflexes win. When one fires it sets `state.reflex`, and every skill checks
// that and gets out of the way — otherwise the two layers fight over the same
// legs and she walks into the thing she is running from.
const { goals } = require("mineflayer-pathfinder");

// Below this, running beats winning.
const FLEE_HEALTH = 14;
// Only worth swinging at something already on top of her. Charging a zombie
// across twelve blocks at night is how she died three times in two minutes.
const ENGAGE_RANGE = 3.5;
// Fists are not a weapon. Without one of these she runs from everything.
const WEAPONS = /_(sword|axe)$/;
// Respawning puts her back at the spawn point, which is where the thing that
// killed her still is. A moment to get clear beats walking into it again.
const RESPAWN_GRACE_MS = 6000;
// Things worth hitting. Creepers are deliberately not here: walking up to one
// and punching it is how you lose everything you were carrying.
const HOSTILE = new Set([
  "zombie", "husk", "drowned", "zombie_villager", "skeleton", "stray", "bogged",
  "spider", "cave_spider", "witch", "pillager", "vindicator", "vex", "silverfish",
  "slime", "magma_cube", "blaze", "piglin_brute", "hoglin", "zoglin", "phantom",
]);
// Things to put distance between yourself and instead.
const AVOID = new Set(["creeper", "warden", "ravager", "evoker", "ender_dragon", "wither"]);

// Close enough to be a problem. Anything further away is scenery: fleeing every
// skeleton within twelve blocks at night meant she never finished a single
// thing, which is its own way of dying.
const PANIC_RANGE = 6;
const AVOID_RANGE = 8;
// A hit in the last few seconds means the thing over there is actually on her,
// not just nearby.
const RECENTLY_HURT_MS = 5000;
const FLEE_DISTANCE = 24;
const CHECK_INTERVAL_MS = 1000;

/**
 * Turns the reflexes on and hands back the shared state. `state.reflex` is the
 * one thing skills need to look at: non-null means something more urgent than
 * whatever they were doing is happening right now.
 */
function installReflexes(bot, { log }) {
  const state = { reflex: null, lastSaid: 0, graceUntil: 0, lastHurt: 0 };

  // Health only ever drops from something happening to her, and knowing *when*
  // is what separates "a skeleton is over there" from "a skeleton is shooting me".
  let lastHealth = 20;
  bot.on("health", () => {
    if (bot.health < lastHealth) state.lastHurt = Date.now();
    lastHealth = bot.health;
  });

  const enter = (name, why) => {
    if (state.reflex === name) return false;
    state.reflex = name;
    log(`[반사] ${name} — ${why}`);
    return true;
  };
  const leave = (name) => {
    if (state.reflex !== name) return;
    state.reflex = null;
    log(`[반사] ${name} 끝`);
  };

  // --- 먹기 ---------------------------------------------------------------
  // Left to the plugin: it watches hunger and handles the eating animation.
  // Rotten flesh is food, but the poison costs more than the hunger it gives
  // back whenever anything else is in the bag.
  bot.autoEat.setOpts({
    minHunger: 16,
    minHealth: 14,
    bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"],
    returnToLastItem: true,
    offhand: false,
  });
  bot.autoEat.enableAuto();
  bot.on("autoeat_started", (item) => log(`[반사] 먹는 중: ${item?.name ?? "?"}`));
  bot.on("autoeat_error", (err) => log(`[반사] 먹기 실패: ${err?.message ?? err}`));

  // --- 도망 / 반격 --------------------------------------------------------
  const nearestOf = (names, range) => {
    let best = null;
    let bestDist = range;
    for (const entity of Object.values(bot.entities)) {
      if (!entity || entity === bot.entity || !entity.name) continue;
      if (!names.has(entity.name)) continue;
      const dist = entity.position.distanceTo(bot.entity.position);
      if (dist < bestDist) {
        best = entity;
        bestDist = dist;
      }
    }
    return best;
  };

  const flee = (from, why) => {
    if (!enter("도망", why)) return;
    bot.pvp.stop();
    // Invert a goal that would walk toward the threat: the same pathing, run
    // backwards. A plain "walk to a point" would happily route past it.
    bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(from, FLEE_DISTANCE)), true);
    setTimeout(() => {
      bot.pathfinder.setGoal(null);
      leave("도망");
    }, 6000);
  };

  /** Armed and healthy enough that swinging back is better than running. */
  const canFight = () =>
    bot.health > FLEE_HEALTH && bot.inventory.items().some((i) => WEAPONS.test(i.name));

  const tick = () => {
    if (!bot.entity || bot.isSleeping) return;
    if (Date.now() < state.graceUntil) return;

    // Never punched, whatever she is holding.
    const scary = nearestOf(AVOID, AVOID_RANGE);
    if (scary) return flee(scary, `${scary.name} 가 ${scary.position.distanceTo(bot.entity.position).toFixed(1)}칸 앞`);

    const hostile = nearestOf(HOSTILE, PANIC_RANGE);
    if (!hostile) {
      if (state.reflex === "반격") {
        bot.pvp.stop();
        leave("반격");
      }
      return;
    }

    const distance = hostile.position.distanceTo(bot.entity.position);
    const armed = canFight();
    const bleeding = Date.now() - state.lastHurt < RECENTLY_HURT_MS;

    // Already within arm's reach: swing back if that is a fight she can win,
    // otherwise get out.
    if (distance <= ENGAGE_RANGE) {
      if (armed) {
        if (enter("반격", `${hostile.name} (${distance.toFixed(1)}칸)`)) bot.pvp.attack(hostile);
      } else {
        flee(hostile, `맨손이라 ${hostile.name} 을 피함`);
      }
      return;
    }

    // Nearby but not on her. Only worth dropping everything for if it is
    // actually landing hits, or she is in no shape to take one.
    if (bleeding || bot.health <= FLEE_HEALTH) {
      flee(hostile, `${hostile.name} 한테 맞는 중 (체력 ${bot.health.toFixed(0)})`);
    }
  };

  const timer = setInterval(() => {
    try {
      tick();
    } catch (err) {
      log(`[반사] 오류: ${err.message}`);
    }
  }, CHECK_INTERVAL_MS);

  bot.on("death", () => {
    state.reflex = null;
    state.graceUntil = Date.now() + RESPAWN_GRACE_MS;
    bot.pvp.stop();
    bot.pathfinder.setGoal(null);
    log("[반사] 죽었다 — 잠깐 가만히 있는다");
  });

  // --- 밤에 자기 ----------------------------------------------------------
  // Sleeping skips the night, which is the cheapest way to not meet the things
  // that come out in it. It needs a bed, so this says so plainly when there
  // isn't one rather than pretending the night is handled.
  const trySleep = async () => {
    if (bot.isSleeping || bot.time.isDay || state.reflex) return;

    const bed = bot.findBlock({ matching: (b) => b && bot.isABed(b), maxDistance: 24 });
    if (!bed) {
      // Once an in-game night, not once a second.
      if (Date.now() - state.lastSaid > 60_000) {
        state.lastSaid = Date.now();
        log("[반사] 밤인데 침대가 없다");
      }
      return;
    }

    if (!enter("자기", "밤")) return;
    try {
      await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
      await bot.sleep(bed);
      log("[반사] 잔다");
    } catch (err) {
      log(`[반사] 못 잤다: ${err.message}`);
      leave("자기");
    }
  };

  bot.on("time", () => {
    if (bot.time.isDay && bot.isSleeping) {
      bot.wake().catch(() => {});
    }
    if (!bot.time.isDay) void trySleep();
  });
  bot.on("wake", () => {
    log("[반사] 일어났다");
    leave("자기");
  });

  return {
    state,
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { installReflexes, HOSTILE, AVOID };
