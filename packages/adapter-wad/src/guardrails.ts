/**
 * WAD 的可玩性护栏（docs/design.md 第 8 节）：补丁引擎在写入前对每个拟议改动运行这些钩子。
 * block 类默认拒绝，补丁在 allowProtected 中写出钩子名才放行；warn 类只报告。
 * 钩子看到的是输入值，只检查新写入的改动，不因地图里已有的非常规数据报错。
 * 通过这些检查只说明这些规则没有触发，不说明地图可以通关。
 */
import type { ProposedChange, ProtectionHook, RecordReader } from "@necrohex/core";
import { mapBossTypes, SOLID_CATEGORIES, thingInfo } from "./thing-types.ts";
import { NO_INDEX, type MapScope, type WadFile } from "./wad.ts";

/** record-source 交给钩子的上下文：读取只读记录（LINEDEFS、SIDEDEFS）推导扇区的触发关系。 */
export class WadHookContext {
  readonly #wad: WadFile;
  readonly #scopes: ReadonlyMap<string, MapScope>;
  readonly #linked = new Map<string, ReadonlySet<number>>();

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

export const WAD_HOOKS: readonly ProtectionHook[] = Object.freeze([
  sectorSpecialNonzero,
  thingPlayerStart,
  thingTeleportDestination,
  thingKey,
  thingBoss,
  thingCategory,
  thingSizeIncrease,
  sectorHeightLinked,
]);
