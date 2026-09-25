// The things she knows how to do.
//
// Each skill is one plain-language verb — go there, mine that, make this — and
// each one answers the same way: `{ ok, detail }`. Nothing here throws at the
// caller. The planner is a language model reading the result and deciding what
// to try next, so "there is no oak within 64 blocks" has to come back as an
// answer it can reason about, not as a stack trace.
//
// Every skill yields to the reflexes. If she is running from a creeper, this
// layer stops asking her to walk somewhere.
const { goals, Movements } = require("mineflayer-pathfinder");

const DEFAULT_SEARCH = 64;
const SKILL_TIMEOUT_MS = 90_000;
// One awkward block shouldn't eat the whole job, and the whole job shouldn't
// leave the planner waiting minutes for one verb.
const MINE_BUDGET_MS = 120_000;
const MOVE_TIMEOUT_MS = 45_000;
// A little under the server's block-interaction limit, measured from her eyes.
const REACH = 4.0;
const DIG_TIMEOUT_MS = 20_000;
// Long enough for the drop to fall and be walked over, short enough that she
// isn't standing in a clearing admiring it.
const PICKUP_MS = 6000;
const PICKUP_WALK_MS = 8000;

/** Wood by any other name. The planner says "나무", not "birch_log". */
const GROUPS = {
  wood: ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log"],
  planks: ["oak_planks", "birch_planks", "spruce_planks", "jungle_planks", "acacia_planks", "dark_oak_planks", "mangrove_planks", "cherry_planks", "pale_oak_planks"],
  stone: ["stone", "cobblestone", "deepslate", "cobbled_deepslate", "andesite", "diorite", "granite"],
  coal: ["coal_ore", "deepslate_coal_ore"],
  iron: ["iron_ore", "deepslate_iron_ore"],
  dirt: ["dirt", "grass_block", "coarse_dirt", "rooted_dirt"],
  sand: ["sand", "red_sand"],
};

/**
 * Whether a recipe is safe to make in the 2x2 grid in her own inventory.
 *
 * On 26.1 mineflayer misplaces items for shaped recipes that leave a slot in
 * that grid empty: asking for sticks (two planks, one above the other) put a
 * single plank in and the server happily turned it into a button. Recipes that
 * fill the grid completely — a crafting table — come out right, and shapeless
 * ones (logs into planks) never had the problem. Anything else goes to a table,
 * where the 3x3 window places correctly.
 */
function fitsInventoryGrid(recipe) {
  if (!recipe.inShape) return true;
  const rows = recipe.inShape.length;
  const cols = Math.max(...recipe.inShape.map((row) => row.length));
  if (rows > 2 || cols > 2) return false;
  return recipe.inShape.every((row) => row.length === cols && row.every((cell) => cell !== null));
}

class Skills {
  constructor(bot, { log, state }) {
    this.bot = bot;
    this.log = log;
    // The reflex layer's state. Read, never written.
    this.state = state;
    this.mcData = require("minecraft-data")(bot.version);
    this.movements = new Movements(bot, this.mcData);
    // Pillaring up. Without it she cannot reach anything on a ledge above her,
    // and standing in a dip with the trees five blocks up is not a rare
    // accident — it is most of this terrain.
    this.movements.allow1by1towers = true;
    bot.pathfinder.setMovements(this.movements);
  }

  /** Reflexes outrank skills; this is how a skill notices and stops. */
  busy() {
    return this.state.reflex ? `지금 ${this.state.reflex} 중이라 못 해` : null;
  }

  ids(names) {
    return names.map((n) => this.mcData.blocksByName[n]).filter(Boolean).map((b) => b.id);
  }

  /** "wood" → every log; "oak_log" → just that. */
  resolve(name) {
    return GROUPS[name] ?? [name];
  }

  async withTimeout(promise, ms, what) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${what} 이 ${Math.round(ms / 1000)}초 안에 안 끝났어`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // --- 이동 ---------------------------------------------------------------

  async goTo(x, y, z, range = 1) {
    const blocked = this.busy();
    if (blocked) return { ok: false, detail: blocked };
    try {
      await this.withTimeout(
        this.bot.pathfinder.goto(new goals.GoalNear(x, y, z, range)),
        SKILL_TIMEOUT_MS,
        "이동"
      );
      const p = this.bot.entity.position;
      return { ok: true, detail: `${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)} 에 도착했어` };
    } catch (err) {
      this.bot.pathfinder.setGoal(null);
      return { ok: false, detail: `거기까지 못 갔어: ${err.message}` };
    }
  }

  // --- 캐기 ---------------------------------------------------------------

  /**
   * Digs up `count` of something. Looks first and says when there are none,
   * because "I mined 0 oak" and "there is no oak here" mean different things
   * to whatever is planning the next step.
   */
  async mine(name, count = 1, maxDistance = DEFAULT_SEARCH) {
    const blocked = this.busy();
    if (blocked) return { ok: false, detail: blocked };

    const names = this.resolve(name);
    const ids = this.ids(names);
    if (!ids.length) return { ok: false, detail: `"${name}" 이 뭔지 모르겠어` };

    const positions = this.bot.findBlocks({ matching: ids, maxDistance, count });
    if (!positions.length) {
      return { ok: false, detail: `${maxDistance}칸 안에 ${name} 이 없어` };
    }

    const targets = positions
      .map((p) => this.bot.blockAt(p))
      .filter(Boolean)
      .map((b) => this.trunkBase(b));
    let got = 0;
    let lastProblem = null;
    // A whole-job budget as well as a per-block one: three blocks that each
    // take their full timeout is four minutes of the planner waiting on one verb.
    const deadline = Date.now() + MINE_BUDGET_MS;
    for (const target of targets) {
      const stop = this.busy();
      if (stop) {
        this.log(`[기술] 캐기 중단 — ${stop}`);
        break;
      }
      if (Date.now() > deadline) {
        this.log("[기술] 캐기 전체 시간 초과");
        break;
      }
      const dist = target.position.distanceTo(this.bot.entity.position).toFixed(1);
      this.log(`[기술] ${target.name} 캐는 중 (${dist}칸)`);
      try {
        if (await this.digOne(target)) got += 1;
      } catch (err) {
        // Kept, because it is the answer the planner needs: "couldn't mine it"
        // and "it is six blocks above me and I have nothing to climb with" call
        // for completely different next moves.
        const rise = Math.round(target.position.y - this.bot.entity.position.y);
        lastProblem =
          rise >= 2
            ? `${target.name} 이 ${rise}칸 위에 있는데 올라갈 수가 없어 (쌓을 블록이 없거나 길이 막혔어)`
            : `${target.name} 까지 못 갔어: ${err.message}`;
        this.log(`[기술] ${lastProblem}`);
        this.bot.pathfinder.setGoal(null);
      }
    }

    // Whatever happened, do not leave her standing in a treetop.
    await this.descendIfStranded();

    if (got === 0) {
      const sample = this.mcData.blocksByName[targets[0].name];
      const needsTool =
        sample?.harvestTools && !this.bot.inventory.items().some((i) => sample.harvestTools[i.type]);
      return {
        ok: false,
        detail: needsTool
          ? `${name} 은 맞는 도구가 없어서 못 캐. 도구부터 만들어야 해`
          : lastProblem ?? `${name} 을 ${targets.length}개 찾았는데 하나도 못 캤어`,
      };
    }
    return { ok: true, detail: `${name} ${got}개 캤어${got < count ? ` (${count}개 하려다 ${got}개)` : ""}` };
  }

  /**
   * Walk to a block, break it, and pick up what falls.
   *
   * This is mineflayer-collectblock's job, and on 26.1 it does not do it: a log
   * two blocks away times out, and when it does return "collected" the item is
   * still lying on the ground. The three steps underneath it — path, dig, walk
   * over the drop — each work fine, so they are used directly.
   */
  /**
   * The bottom of a trunk, given any block of it.
   *
   * The nearest log is usually partway up a tree, and there is nowhere to stand
   * next to it — the whole column is wrapped in leaves, so pathfinding spends
   * its timeout looking for a foothold that does not exist. The base of the
   * trunk has ground beside it, and felling from the bottom drops the rest.
   */
  trunkBase(block) {
    if (!/_log$|_stem$/.test(block.name)) return block;
    let base = block;
    for (let drop = 1; drop < 16; drop += 1) {
      const below = this.bot.blockAt(block.position.offset(0, -drop, 0));
      if (!below || below.name !== block.name) break;
      base = below;
    }
    return base;
  }

  /** Roughly how far she can reach; further than this and she has to walk. */
  inReach(position) {
    return position.distanceTo(this.bot.entity.position.offset(0, 1.6, 0)) <= REACH;
  }

  async digOne(target) {
    const { x, y, z } = target.position;

    // Walking is for blocks she cannot already touch. A tree trunk three steps
    // away is in reach, and asking pathfinder to stand next to it fails — the
    // spots around it are full of leaves, so there is nowhere to stand and it
    // spends its whole timeout looking.
    if (!this.inReach(target.position)) {
      try {
        // GoalGetToBlock, not GoalNear: "stand somewhere you can touch this"
        // rather than "stand within N of this point". A block inside a tree or
        // a hillside has no standing room at its own coordinates, and GoalNear
        // spends its whole timeout looking for some.
        await this.withTimeout(
          this.bot.pathfinder.goto(new goals.GoalGetToBlock(x, y, z)),
          MOVE_TIMEOUT_MS,
          "접근"
        );
      } catch (err) {
        // Not fatal on its own: she may have got close enough on the way.
        this.bot.pathfinder.setGoal(null);
        if (!this.inReach(target.position)) throw err;
        this.log(`[기술] 끝까지 못 갔지만 손은 닿아 (${err.message})`);
      }
    }

    // It may be gone by now — gravity, another mob, a previous swing that took
    // the whole tree.
    const block = this.bot.blockAt(target.position);
    if (!block || block.name === "air") return false;
    if (!this.bot.canDigBlock(block)) {
      this.log(`[기술] ${block.name} 을 못 캐 (손이 안 닿거나 도구가 없음)`);
      return false;
    }

    // Stone barehanded takes half a minute and then drops nothing at all.
    // Saying so immediately is more use to the planner than a timeout.
    const data = this.mcData.blocksByName[block.name];
    if (data?.harvestTools && !this.bot.inventory.items().some((i) => data.harvestTools[i.type])) {
      this.log(`[기술] ${block.name} 은 맞는 도구가 없으면 캐도 안 나와`);
      return false;
    }

    await this.equipBestTool(block.name);
    await this.withTimeout(this.bot.dig(block), DIG_TIMEOUT_MS, "캐기");
    await this.pickUpNear(target.position);
    return true;
  }

  /**
   * Gets down out of a tree.
   *
   * Felling a tree means pathing up its trunk, and when the job ends she is
   * left standing on the canopy. Leaves decay once their log is gone, so she
   * would eventually drop the whole way to the ground and take the fall.
   */
  async descendIfStranded() {
    const under = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
    if (!under || !/leaves/.test(under.name)) return;

    let groundY = null;
    for (let drop = 2; drop < 32; drop += 1) {
      const block = this.bot.blockAt(this.bot.entity.position.offset(0, -drop, 0));
      if (!block) break;
      if (block.name !== "air" && block.name !== "cave_air" && !/leaves/.test(block.name)) {
        groundY = block.position.y + 1;
        break;
      }
    }
    if (groundY === null) return;

    this.log(`[기술] 나뭇잎 위라 ${Math.round(this.bot.entity.position.y - groundY)}칸 내려간다`);
    try {
      await this.withTimeout(this.bot.pathfinder.goto(new goals.GoalY(groundY)), MOVE_TIMEOUT_MS, "내려가기");
    } catch (err) {
      this.bot.pathfinder.setGoal(null);
      this.log(`[기술] 못 내려왔어: ${err.message}`);
    }
  }

  /** Walks over whatever is lying around; mineflayer picks items up on contact. */
  async pickUpNear(position) {
    const deadline = Date.now() + PICKUP_MS;
    const seen = new Set();
    while (Date.now() < deadline) {
      const drop = Object.values(this.bot.entities).find(
        (e) =>
          e &&
          !seen.has(e.id) &&
          (e.name === "item" || e.objectType === "Item" || e.displayName === "Item") &&
          e.position.distanceTo(position) < 6
      );
      if (!drop) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      seen.add(drop.id);
      // Range 1, not 0: mineflayer picks an item up on contact, and demanding
      // she stand exactly on its block is a goal that often cannot be met.
      try {
        await this.withTimeout(
          this.bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1)),
          PICKUP_WALK_MS,
          "줍기"
        );
        await new Promise((r) => setTimeout(r, 400));
      } catch {
        /* one unreachable drop is not worth failing the dig over */
      }
    }
  }

  // --- 제작 ---------------------------------------------------------------

  countItem(name) {
    return this.bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
  }

  /** The nearest table, or one she puts down herself. Most recipes need one. */
  async craftingTable() {
    const id = this.mcData.blocksByName.crafting_table?.id;
    const existing = id ? this.bot.findBlock({ matching: [id], maxDistance: 16 }) : null;
    if (existing) return existing;

    if (this.countItem("crafting_table") === 0) {
      // Crafted here directly, never through craft(). craft() looks for a table
      // when it can't make something, which would come straight back into this
      // function — and with an empty inventory that recurses until the stack
      // gives out. A table is a 2x2 recipe, so it never needed one anyway.
      const item = this.mcData.itemsByName.crafting_table;
      const recipes = item ? this.bot.recipesFor(item.id, null, 1, null).filter(fitsInventoryGrid) : [];
      if (!recipes.length) {
        this.log("[기술] 작업대를 만들 재료(판자 4개)가 없어");
        return null;
      }
      try {
        await this.withTimeout(this.bot.craft(recipes[0], 1, null), SKILL_TIMEOUT_MS, "작업대 제작");
      } catch (err) {
        this.log(`[기술] 작업대 제작 실패: ${err.message}`);
        return null;
      }
    }

    const item = this.bot.inventory.items().find((i) => i.name === "crafting_table");
    if (!item) return null;

    // Place it, then look for where it actually landed — placing can succeed
    // against a face other than the one we aimed at.
    const ground = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
    if (!ground) return null;
    try {
      await this.bot.equip(item, "hand");
      await this.bot.placeBlock(ground, { x: 0, y: 1, z: 0 });
    } catch (err) {
      this.log(`[기술] 작업대 설치 실패: ${err.message}`);
      return null;
    }
    return id ? this.bot.findBlock({ matching: [id], maxDistance: 6 }) : null;
  }

  /**
   * Makes something. Recipes that need a table get one; recipes that are short
   * on materials say which ones rather than failing blankly.
   */
  async craft(name, count = 1) {
    const blocked = this.busy();
    if (blocked) return { ok: false, detail: blocked };

    // "planks" is a dozen different items depending on which tree she happened
    // to find. Asking for the group and letting her pick the one she has wood
    // for is the difference between a planner that works and one that has to
    // know she is standing in a birch forest.
    const candidates = (GROUPS[name] ?? [name]).filter((n) => this.mcData.itemsByName[n]);
    if (!candidates.length) return { ok: false, detail: `"${name}" 이라는 아이템이 없어` };

    // A table only gets fetched once, and never for the table itself.
    let table = null;
    let fetchedTable = false;
    const withTable = async () => {
      if (!fetchedTable) {
        fetchedTable = true;
        table = name === "crafting_table" ? null : await this.craftingTable();
      }
      return table;
    };

    for (const candidate of candidates) {
      const item = this.mcData.itemsByName[candidate];
      // Her own 2x2 first — no walking, no table — but only for shapes it can
      // actually hold (see fitsInventoryGrid).
      let recipes = this.bot.recipesFor(item.id, null, count, null).filter(fitsInventoryGrid);
      let using = null;
      if (!recipes.length) {
        using = await withTable();
        if (using) recipes = this.bot.recipesFor(item.id, null, count, using);
      }
      if (!recipes.length) continue;

      try {
        await this.withTimeout(this.bot.craft(recipes[0], count, using), SKILL_TIMEOUT_MS, "제작");
        return { ok: true, detail: `${candidate} ${count}개 만들었어 (가진 것 ${this.countItem(candidate)}개)` };
      } catch (err) {
        return { ok: false, detail: `${candidate} 만들다 실패했어: ${err.message}` };
      }
    }

    return { ok: false, detail: this.whyNot(name, candidates, table) };
  }

  /**
   * Why a recipe didn't happen, in terms of what to go get. Reports the variant
   * she is closest to making, not an arbitrary one — "cherry planks" is useless
   * advice to someone holding birch logs.
   */
  whyNot(name, candidates, table) {
    let best = null;
    for (const candidate of candidates) {
      const item = this.mcData.itemsByName[candidate];
      for (const recipe of this.bot.recipesAll(item.id, null, table)) {
        const missing = recipe.delta
          .filter((d) => d.count < 0)
          .map((d) => {
            const need = -d.count;
            const itemName = this.mcData.items[d.id]?.name ?? String(d.id);
            return { itemName, short: need - this.countItem(itemName) };
          })
          .filter((m) => m.short > 0);
        if (!missing.length) continue;
        const shortfall = missing.reduce((n, m) => n + m.short, 0);
        if (!best || shortfall < best.shortfall) best = { candidate, missing, shortfall };
      }
    }
    if (!best) {
      const needsTable = !table && name !== "crafting_table";
      return needsTable
        ? `${name} 은 작업대가 있어야 하는데 작업대를 못 구했어`
        : `${name} 만드는 법을 모르겠어`;
    }
    const need = best.missing.map((m) => `${m.itemName} ${m.short}개`).join(", ");
    return `${best.candidate} 만들려면 ${need} 가 더 있어야 해`;
  }

  // --- 장비 ---------------------------------------------------------------

  /** Holds the best tool she owns for a block, so mining isn't done bare-handed. */
  async equipBestTool(blockName) {
    const block = this.mcData.blocksByName[blockName];
    if (!block) return { ok: false, detail: `"${blockName}" 이 뭔지 모르겠어` };

    const usable = this.bot.inventory
      .items()
      .filter((i) => (block.harvestTools ? block.harvestTools[i.type] : /pickaxe|axe|shovel|hoe|sword/.test(i.name)));
    if (!usable.length) return { ok: false, detail: `${blockName} 에 쓸 도구가 없어` };

    const rank = ["netherite", "diamond", "iron", "stone", "golden", "wooden"];
    usable.sort((a, b) => rank.findIndex((m) => a.name.startsWith(m)) - rank.findIndex((m) => b.name.startsWith(m)));
    await this.bot.equip(usable[0], "hand");
    return { ok: true, detail: `${usable[0].name} 들었어` };
  }

  // --- 상태 ---------------------------------------------------------------

  inventorySummary() {
    const items = this.bot.inventory.items();
    if (!items.length) return "가방이 비었어";
    const counts = new Map();
    for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
    return [...counts].map(([n, c]) => `${n} ${c}`).join(", ");
  }

  status() {
    const p = this.bot.entity.position;
    return [
      `위치 ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}`,
      `체력 ${this.bot.health ?? "?"} · 배고픔 ${this.bot.food ?? "?"}`,
      this.bot.time.isDay ? "낮" : "밤",
      this.state.reflex ? `지금 ${this.state.reflex} 중` : "가만히 있음",
      `가방: ${this.inventorySummary()}`,
    ].join(" · ");
  }
}

module.exports = { Skills, GROUPS };
