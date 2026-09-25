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
// How players actually fight: swing, step out of its reach while the weapon
// recharges, step back in. A sword recharges in 0.625s.
// Her reach is about 3 blocks and a zombie's is about 2.3, and that gap is the
// whole trick: hover at the edge of hers and it never gets to swing.
const ATTACK_REACH = 3.0;
// Anything closer than this while the weapon is recharging means backing up.
const SAFE_GAP = 3.6;
const SWING_INTERVAL_MS = 650;
// Fists recharge fast enough to swing almost continuously, which would mean
// standing in its face. Slower on purpose, to leave time to step out.
const FIST_INTERVAL_MS = 900;
// Kiting works against one thing at a time. Surrounded, she runs.
const CROWD = 2;
// A creeper lights up within three blocks and blows up 1.5s later — but the
// fuse goes out if she leaves that radius, so backing off far enough after each
// swing is what makes it survivable rather than a trade.
const CREEPER_RETREAT_MS = 1100;
const CREEPER_SAFE_DISTANCE = 5;
const KITE_TIMEOUT_MS = 20_000;
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
// Slow things that have to touch her to hurt her. Stepping back out of reach
// works on these even bare-handed — it is only slow, not dangerous. Archers are
// not on this list: backing away from an arrow accomplishes nothing.
const MELEE_MOBS = new Set([
  "zombie", "husk", "drowned", "zombie_villager", "spider", "cave_spider",
  "silverfish", "slime", "magma_cube", "vindicator", "zoglin", "hoglin",
]);

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

  const countNear = (names, range) => {
    let n = 0;
    for (const entity of Object.values(bot.entities)) {
      if (!entity || entity === bot.entity || !entity.name) continue;
      if (names.has(entity.name) && entity.position.distanceTo(bot.entity.position) < range) n += 1;
    }
    return n;
  };

  const clearMovement = () => {
    for (const control of ["forward", "back", "left", "right", "sprint", "jump"]) {
      bot.setControlState(control, false);
    }
  };

  /**
   * Is there still ground behind her?
   *
   * Backing away from a creeper into a ravine is a worse outcome than the
   * creeper. Checks the block she would step onto and the one under it.
   */
  const canBackUp = () => {
    const yaw = bot.entity.yaw;
    // Straight backwards in world space, one step out.
    const back = bot.entity.position.offset(Math.sin(yaw) * 1.2, 0, -Math.cos(yaw) * 1.2);
    const floor = bot.blockAt(back.offset(0, -1, 0));
    const at = bot.blockAt(back);
    if (!floor || !at) return false;
    if (floor.name === "air" || floor.name === "cave_air") return false;
    if (/lava|fire|magma|campfire/.test(floor.name) || /lava|fire/.test(at.name)) return false;
    return true;
  };

  /**
   * Swing, step back, swing again — the way a person fights, rather than
   * standing inside a zombie trading hits until one of them falls over.
   */
  const kite = async (target) => {
    const isCreeper = target.name === "creeper";
    if (!enter("치고빠지기", `${target.name}`)) return;

    const interval = canFight() ? SWING_INTERVAL_MS : FIST_INTERVAL_MS;
    const deadline = Date.now() + KITE_TIMEOUT_MS;
    let lastSwing = 0;
    try {
      while (Date.now() < deadline) {
        const entity = bot.entities[target.id];
        if (!entity || !entity.isValid || bot.health <= 0) break;

        const distance = entity.position.distanceTo(bot.entity.position);
        if (distance > 12) break;
        // Too hurt to keep trading, or more than one of them: let the tick turn
        // this into a run.
        if (bot.health <= FLEE_HEALTH) break;
        if (countNear(HOSTILE, 6) + countNear(AVOID, 6) >= CROWD) {
          log("[반사] 둘 이상이라 치고빠지기 그만");
          break;
        }

        await bot.lookAt(entity.position.offset(0, entity.height * 0.5, 0), true);

        const ready = Date.now() - lastSwing >= interval;
        // A creeper has to be left alone long enough for its fuse to die, so it
        // gets a longer wait and a wider berth than the timer alone would give.
        const holdBack = isCreeper && Date.now() - lastSwing < CREEPER_RETREAT_MS;
        const keepAway = isCreeper ? CREEPER_SAFE_DISTANCE : SAFE_GAP;

        if (ready && !holdBack && distance <= ATTACK_REACH) {
          clearMovement();
          bot.attack(entity);
          lastSwing = Date.now();
        } else if ((!ready || holdBack) && distance < keepAway && canBackUp()) {
          // Recharging: everything about being close right now is downside.
          bot.setControlState("forward", false);
          bot.setControlState("back", true);
        } else if (ready && !holdBack && distance > ATTACK_REACH) {
          // Step in only far enough to land one, never past the edge of reach.
          bot.setControlState("back", false);
          bot.setControlState("forward", true);
        } else {
          clearMovement();
        }

        await new Promise((r) => setTimeout(r, 100));
      }
    } catch (err) {
      log(`[반사] 치고빠지기 중 오류: ${err.message}`);
    } finally {
      clearMovement();
      leave("치고빠지기");
    }
  };

  const flee = (from, why) => {
    if (!enter("도망", why)) return;
    clearMovement();
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

    const armed = canFight();

    // A creeper is only safe to fight the way people fight one: swing, get out
    // of the blast radius so the fuse dies, swing again. Without a weapon there
    // is no swinging, so there is only running.
    const scary = nearestOf(AVOID, AVOID_RANGE);
    if (scary) {
      const distance = scary.position.distanceTo(bot.entity.position);
      if (scary.name === "creeper" && armed) return void kite(scary);
      return flee(scary, `${scary.name} 가 ${distance.toFixed(1)}칸 앞`);
    }

    const hostile = nearestOf(HOSTILE, PANIC_RANGE);
    if (!hostile) return;

    const distance = hostile.position.distanceTo(bot.entity.position);
    const bleeding = Date.now() - state.lastHurt < RECENTLY_HURT_MS;

    // Already within arm's reach: fight it properly if she can, otherwise get out.
    // Bare-handed against something slow is still a fight worth having — it
    // takes a while, but stepping back out of reach means it never lands a hit.
    if (distance <= ENGAGE_RANGE) {
      const winnable = armed || (MELEE_MOBS.has(hostile.name) && bot.health > FLEE_HEALTH);
      if (winnable) return void kite(hostile);
      return flee(hostile, `${armed ? "" : "맨손이라 "}${hostile.name} 을 피함`);
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
    clearMovement();
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
