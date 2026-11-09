/**
 * WAD 的可玩性护栏（docs/design.md 第 8 节）：补丁引擎在写入前对每个拟议改动运行这些钩子。
 * block 类默认拒绝，补丁在 allowProtected 中写出钩子名才放行；warn 类只报告。
 * 逐条的 check 看到的是输入值；sector-light-effect-invisible 用 checkPatch 看补丁之后的值。
 * 只检查补丁触及的记录，不因地图里已有的非常规数据报错。
 * 通过这些检查只说明这些规则没有触发，不说明地图可以通关。
 */
import type { HookFinding, ProposedChange, ProtectionHook, RecordReader } from "@necrohex/core";
import { mapBossTypes, SOLID_CATEGORIES, thingInfo } from "./thing-types.ts";
import { NO_INDEX, type MapScope, type WadFile } from "./wad.ts";

/** Linedef.flags 的双面标志。 */
const ML_TWOSIDED = 4;

/** record-source 交给钩子的上下文：读取只读记录（LINEDEFS、SIDEDEFS）推导扇区的触发关系。 */
export class WadHookContext {
  readonly #wad: WadFile;
  readonly #scopes: ReadonlyMap<string, MapScope>;
  readonly #linked = new Map<string, ReadonlySet<number>>();
  readonly #neighbors = new Map<string, readonly ReadonlySet<number>[]>();

  constructor(wad: WadFile, scopes: ReadonlyMap<string, MapScope>) {
    this.#wad = wad;
    this.#scopes = scopes;
  }

  mapName(scope: string): string | undefined {
    return this.#scopes.get(scope)?.name;
  }

  /**
   * 被线段直接触发的扇区：带特效、tag 为 0 的线段背面所在的扇区（原版手动门的作用对象）。
   * 只读输入；LINEDEFS 和 SIDEDEFS 不可写，所以结果在一次运行中不变。
   */
  manualSectors(scope: string): ReadonlySet<number> {
    const hit = this.#linked.get(scope);
    if (hit) return hit;
    const out = new Set<number>();
    const m = this.#scopes.get(scope);
    const lines = m?.lumps["LINEDEFS"];
    const sides = m?.lumps["SIDEDEFS"];
    if (lines !== undefined && sides !== undefined) {
      const sideCount = this.#wad.recordCount(sides, "Sidedef");
      for (const l of this.#wad.readRecords(lines, "Linedef")) {
        if (l.special === 0 || l.tag !== 0) continue;
        const back = l.sidenum[1];
        if (back === NO_INDEX || back >= sideCount) continue;
        out.add(this.#wad.readRecord(sides, "Sidedef", back).sector);
      }
    }
    this.#linked.set(scope, out);
    return out;
  }

  /**
   * 每个扇区的邻居：带双面标志（ML_TWOSIDED，flags & 4）、两侧都有 Sidedef 的线段另一侧的扇区，与原版引擎的 getNextSector 一致。
   * 两侧是同一扇区的线段不算；指向不存在的 Sidedef 或扇区的线段跳过。只读输入，结果在一次运行中不变。
   */
  neighbors(scope: string): readonly ReadonlySet<number>[] {
    const hit = this.#neighbors.get(scope);
    if (hit) return hit;
    const m = this.#scopes.get(scope);
    const sectors = m?.lumps["SECTORS"];
    const out: Set<number>[] = Array.from({ length: sectors === undefined ? 0 : this.#wad.recordCount(sectors, "Sector") }, () => new Set<number>());
    const lines = m?.lumps["LINEDEFS"];
    const sides = m?.lumps["SIDEDEFS"];
    if (lines !== undefined && sides !== undefined) {
      const sideCount = this.#wad.recordCount(sides, "Sidedef");
      for (const l of this.#wad.readRecords(lines, "Linedef")) {
        if ((l.flags & ML_TWOSIDED) === 0) continue;
        const [front, back] = l.sidenum;
        if (front === undefined || back === undefined || front >= sideCount || back >= sideCount) continue;
        const a = this.#wad.readRecord(sides, "Sidedef", front).sector;
        const b = this.#wad.readRecord(sides, "Sidedef", back).sector;
        if (a === b || a >= out.length || b >= out.length) continue;
        out[a]!.add(b);
        out[b]!.add(a);
      }
    }
    this.#neighbors.set(scope, out);
    return out;
  }
}

function ctx(context: unknown): WadHookContext | undefined {
  return context instanceof WadHookContext ? context : undefined;
}

function scopeName(change: ProposedChange, reader: RecordReader, context: unknown): string {
  return ctx(context)?.mapName(change.scope) ?? reader.scopes().find((s) => s.id === change.scope)?.name ?? change.scope;
}

function thingType(change: ProposedChange, reader: RecordReader): number {
  const t = change.field === "type" ? change.oldValue : reader.readField({ scope: change.scope, record: "Thing", index: change.index }, "type");
  return t as number;
}

function label(type: number): string {
  const info = thingInfo(type);
  return info ? `${type} (${info.name})` : String(type);
}

/**
 * 保护某一类 Thing：旧类型属于这一类时，拒绝写入它的任何字段；改 type 时，新类型属于这一类也拒绝。
 */
function protectTypes(name: string, description: string, what: string, types: (mapName: string) => ReadonlySet<number>): ProtectionHook {
  return Object.freeze({
    name,
    severity: "block" as const,
    description,
    check(change: ProposedChange, reader: RecordReader, context?: unknown): string | null {
      if (change.record !== "Thing") return null;
      const set = types(scopeName(change, reader, context));
      const old = thingType(change, reader);
      if (set.has(old)) return `Thing type ${label(old)} is a ${what}, and its fields are protected`;
      if (change.field === "type" && typeof change.newValue === "number" && change.newValue !== old && set.has(change.newValue)) {
        return `new Thing type ${label(change.newValue)} is a ${what}, and adding one is protected`;
      }
      return null;
    },
  });
}

const PLAYER_STARTS: ReadonlySet<number> = new Set([1, 2, 3, 4, 11]);
const TELEPORT_DESTINATIONS: ReadonlySet<number> = new Set([14]);
const KEYS: ReadonlySet<number> = new Set([5, 6, 13, 38, 39, 40]);

/** Sector.special 旧值非零时拦截写入 special（秘密房间、门类特效等）。 */
export const sectorSpecialNonzero: ProtectionHook = Object.freeze({
  name: "sector-special-nonzero",
  severity: "block" as const,
  description: "does not overwrite a non-zero Sector.special (secrets, doors, damage and light effects)",
  check: (change: ProposedChange) =>
    change.record === "Sector" && change.field === "special" && change.oldValue !== 0
      ? `Sector.special is ${String(change.oldValue)}, and non-zero specials are protected`
      : null,
});

export const thingPlayerStart = protectTypes(
  "thing-player-start",
  "does not change or add player starts (types 1-4) or deathmatch starts (type 11)",
  "player or deathmatch start",
  () => PLAYER_STARTS,
);

export const thingTeleportDestination = protectTypes(
  "thing-teleport-destination",
  "does not change or add teleport destinations (type 14)",
  "teleport destination",
  () => TELEPORT_DESTINATIONS,
);

export const thingKey = protectTypes("thing-key", "does not change or add keys (types 5, 6, 13, 38, 39, 40)", "key", () => KEYS);

export const thingBoss = protectTypes(
  "thing-boss",
  "does not change or add boss types the map depends on (MAP07 67/68, E1M8 3003, E2M8 and E4M6 16, E3M8 and E4M8 7; 72, 87, 88, 89 on every map)",
  "boss type this map depends on",
  mapBossTypes,
);

/** 改 type 时，新旧类型必须同属一个类别；任一类型不在类型表里也拒绝，因为无法判断类别。 */
export const thingCategory: ProtectionHook = Object.freeze({
  name: "thing-category",
  severity: "block" as const,
  description: "replaces a Thing only with a known type of the same category",
  check(change: ProposedChange): string | null {
    if (change.record !== "Thing" || change.field !== "type" || change.newValue === change.oldValue) return null;
    const a = thingInfo(change.oldValue as number);
    const b = typeof change.newValue === "number" ? thingInfo(change.newValue) : undefined;
    if (!a) return `old Thing type ${String(change.oldValue)} is not a known type, so its category cannot be checked`;
    if (!b) return null; // 新类型未知由结构检查 thing-type-known 拒绝
    if (a.category !== b.category) return `Thing type ${label(a.type)} is a ${a.category}, but ${label(b.type)} is a ${b.category}`;
    return null;
  },
});

/** 阻挡类 Thing 换成半径或高度更大的类型时警告：可能卡在墙里或卡住通道。 */
export const thingSizeIncrease: ProtectionHook = Object.freeze({
  name: "thing-size-increase",
  severity: "warn" as const,
  description: "warns when a blocking Thing (monster, barrel, obstacle) is replaced with a larger one",
  check(change: ProposedChange): string | null {
    if (change.record !== "Thing" || change.field !== "type" || typeof change.newValue !== "number") return null;
    const a = thingInfo(change.oldValue as number);
    const b = thingInfo(change.newValue);
    if (!a || !b || !SOLID_CATEGORIES.has(b.category)) return null;
    const grows: string[] = [];
    if (b.radius > a.radius) grows.push(`radius ${a.radius} -> ${b.radius}`);
    if (b.height > a.height) grows.push(`height ${a.height} -> ${b.height}`);
    return grows.length > 0 ? `${label(b.type)} is larger than ${label(a.type)} (${grows.join(", ")}) and may get stuck` : null;
  },
});

/** 改带 tag 的扇区或手动门作用的扇区的高度时警告：门、升降机等可能失效。 */
export const sectorHeightLinked: ProtectionHook = Object.freeze({
  name: "sector-height-linked",
  severity: "warn" as const,
  description: "warns when a height change touches a tagged sector or one that a line triggers directly",
  check(change: ProposedChange, reader: RecordReader, context?: unknown): string | null {
    if (change.record !== "Sector" || (change.field !== "floorheight" && change.field !== "ceilingheight")) return null;
    if (change.newValue === change.oldValue) return null;
    const tag = reader.readField({ scope: change.scope, record: "Sector", index: change.index }, "tag");
    if (tag !== 0) return `the sector has tag ${String(tag)}, so doors, lifts or other line actions may move it`;
    const c = ctx(context);
    if (!c) return "line links could not be checked, so a line action may move this sector";
    if (c.manualSectors(change.scope).has(change.index)) return "the sector is on the back side of a line with a special, so it is probably a manual door";
    return null;
  },
});

/** 原版引擎里以扇区自身亮度为上限、最暗邻居亮度为下限的灯光特效。 */
const NEIGHBOR_LIGHT_EFFECTS: ReadonlyMap<number, string> = new Map([
  [1, "random blink"],
  [8, "glow"],
  [17, "flicker"],
]);

/**
 * 补丁之后扇区的 special 是 1、8 或 17，但没有比它暗的邻居时警告：这些特效在扇区亮度和最暗邻居亮度之间变化，
 * 没有更暗的邻居时下限等于自身亮度，看不出效果。扇区和邻居都按补丁之后的亮度算。
 * 只检查补丁触及的扇区：改了它的 special 或 lightlevel，或改了某个邻居的 lightlevel。
 * 每个扇区只报一次，挂在相关的第一条改动上（本扇区的 special 优先，其次本扇区的 lightlevel，最后邻居的 lightlevel）。
 */
export const sectorLightEffectInvisible: ProtectionHook = Object.freeze({
  name: "sector-light-effect-invisible",
  severity: "warn" as const,
  description: "warns when, after the patch, a sector with light special 1, 8 or 17 has no darker neighbour across a two-sided line, so the effect cannot be seen",
  check: (): string | null => null,
  checkPatch(changes: readonly ProposedChange[], after: RecordReader, context?: unknown): readonly HookFinding[] {
    const c = ctx(context);
    const owners = new Map<string, { scope: string; index: number; change: ProposedChange; rank: number }>();
    const claim = (scope: string, index: number, change: ProposedChange, rank: number) => {
      const k = `${scope}\u0000${index}`;
      const o = owners.get(k);
      if (!o || rank < o.rank) owners.set(k, { scope, index, change, rank });
    };
    for (const ch of changes) {
      if (ch.record !== "Sector" || ch.newValue === ch.oldValue) continue;
      if (ch.field === "special") claim(ch.scope, ch.index, ch, 0);
      else if (ch.field === "lightlevel") {
        claim(ch.scope, ch.index, ch, 1);
        for (const n of c?.neighbors(ch.scope)[ch.index] ?? []) claim(ch.scope, n, ch, 2);
      }
    }
    const out: HookFinding[] = [];
    for (const { scope, index, change } of owners.values()) {
      const read = (i: number, field: string) => after.readField({ scope, record: "Sector", index: i }, field) as number;
      const special = read(index, "special");
      const effect = NEIGHBOR_LIGHT_EFFECTS.get(special);
      if (effect === undefined) continue;
      const light = read(index, "lightlevel");
      const what = `Sector #${index} has special ${special} (${effect}) and lightlevel ${light} after the patch`;
      if (!c) {
        out.push({ change, message: `${what}, and its neighbours could not be checked, so the effect may not be visible` });
        continue;
      }
      let darkest: { index: number; light: number } | undefined;
      for (const n of c.neighbors(scope)[index] ?? []) {
        const l = read(n, "lightlevel");
        if (!darkest || l < darkest.light || (l === darkest.light && n < darkest.index)) darkest = { index: n, light: l };
      }
      if (!darkest) out.push({ change, message: `${what}, but it has no neighbouring sector across a two-sided line, so the effect will not be visible` });
      else if (darkest.light >= light) {
        out.push({
          change,
          message: `${what}, but its darkest neighbour #${darkest.index} has lightlevel ${darkest.light}; with no darker neighbour the effect will not be visible`,
        });
      }
    }
    return out;
  },
});

export const WAD_HOOKS: readonly ProtectionHook[] = Object.freeze([
  sectorSpecialNonzero,
  thingPlayerStart,
  thingTeleportDestination,
  thingKey,
  thingBoss,
  thingCategory,
  thingSizeIncrease,
  sectorHeightLinked,
  sectorLightEffectInvisible,
]);
