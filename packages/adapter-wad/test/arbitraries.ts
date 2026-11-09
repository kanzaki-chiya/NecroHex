import fc from "fast-check";
import {
  buildWad,
  MAP_DATA_LUMPS,
  RECORD_LAYOUTS,
  WadFile,
  type FieldLayout,
  type FieldType,
  type LumpInput,
} from "../src/index.ts";
import { withFilepos } from "./helpers.ts";

const bytes = (max: number) => fc.uint8Array({ minLength: 0, maxLength: max });

const NAME_CHARS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-[]\\"];
const randomName = fc.array(fc.constantFrom(...NAME_CHARS), { minLength: 1, maxLength: 8 }).map((c) => c.join(""));
const specialName = fc.constantFrom("MAP01", "E1M1", "PLAYPAL", "F_START", "F_END", ...MAP_DATA_LUMPS);

/** 任意 Lump：名称既有常见名也有随机名，原始名称字节偶尔含 NUL 后的杂字节。 */
export const lumpInput: fc.Arbitrary<LumpInput> = fc
  .record({
    name: fc.oneof(specialName, randomName),
    data: bytes(48),
    junkName: fc.option(fc.uint8Array({ minLength: 8, maxLength: 8 }), { nil: undefined }),
    gapBefore: fc.option(bytes(8), { nil: undefined }),
    markerFilepos: fc.option(fc.integer({ min: 0, max: 5000 }), { nil: undefined }),
  })
  .map(({ junkName, ...rest }) => (junkName ? { ...rest, nameBytes: junkName } : rest));

/** 完全随机的合法容器：任意 Lump 顺序、间隙和尾部字节。 */
export const wadBytes: fc.Arbitrary<Uint8Array> = fc
  .record({
    kind: fc.constantFrom("IWAD" as const, "PWAD" as const),
    lumps: fc.array(lumpInput, { maxLength: 14 }),
    gapBeforeDirectory: fc.option(bytes(8), { nil: undefined }),
    trailing: fc.option(bytes(8), { nil: undefined }),
  })
  .map((o) => buildWad(o));

const SECTOR_SIZE = 26;
const THING_SIZE = 10;

function sectorBytes(count: number, seed: readonly number[]): Uint8Array {
  const out = new Uint8Array(count * SECTOR_SIZE);
  for (let i = 0; i < out.length; i++) out[i] = seed[i % seed.length]!;
  return out;
}

/** 长度合法的 THINGS 数据：count 条完整的 10 字节记录。 */
function thingBytes(count: number, seed: readonly number[]): Uint8Array {
  const out = new Uint8Array(count * THING_SIZE);
  for (let i = 0; i < out.length; i++) out[i] = seed[(i + 3) % seed.length]!;
  return out;
}

/** 带一张标准结构地图的 WAD：标记 + 数据 Lump，前后夹杂无关 Lump 和间隙。 */
export const mapWad: fc.Arbitrary<{ bytes: Uint8Array; sectorCount: number; thingCount: number }> = fc
  .record({
    sectorCount: fc.integer({ min: 1, max: 6 }),
    thingCount: fc.integer({ min: 1, max: 6 }),
    seed: fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 30 }),
    before: fc.array(lumpInput, { maxLength: 3 }),
    after: fc.array(lumpInput, { maxLength: 3 }),
    mapName: fc.constantFrom("MAP01", "MAP32", "E1M1", "E4M9"),
    gap: fc.option(bytes(6), { nil: undefined }),
  })
  .map(({ sectorCount, thingCount, seed, before, after, mapName, gap }) => {
    // 前后夹杂的随机 Lump 一律改名为 X 开头，避免与固定地图的标记或数据 Lump 冲突
    const strip = (l: LumpInput): LumpInput => ({
      name: "X" + l.name.slice(0, 7),
      data: l.data,
      ...(l.gapBefore ? { gapBefore: l.gapBefore } : {}),
    });
    const dataLumps: LumpInput[] = MAP_DATA_LUMPS.map((name) => ({
      name,
      data:
        name === "SECTORS"
          ? sectorBytes(sectorCount, seed)
          : name === "THINGS"
            ? thingBytes(thingCount, seed)
            : Uint8Array.of(...seed.slice(0, 5)),
    }));
    const lumps = [...before.map(strip), { name: mapName, data: new Uint8Array(0) }, ...dataLumps, ...after.map(strip)];
    return { bytes: buildWad({ kind: "PWAD", lumps, ...(gap ? { gapBeforeDirectory: gap } : {}) }), sectorCount, thingCount };
  });

export type SectorPlacement = "keep" | "header" | "directory" | "other";

/**
 * mapWad 的变体：只改写 SECTORS 目录项的 filepos，名称、大小和 Lump 顺序不变，
 * 所以 SECTORS 仍在地图作用域内，数据区间保持在文件内。
 * keep：不改；header：数据从文件头内开始；directory：数据结束于文件末尾，与目录重叠；other：与 THINGS 数据重叠。
 */
export const placedMapWad: fc.Arbitrary<{
  bytes: Uint8Array;
  sectorCount: number;
  thingCount: number;
  placement: SectorPlacement;
}> = fc
  .record({
    base: mapWad,
    placement: fc.constantFrom<SectorPlacement>("keep", "header", "directory", "other"),
    headerAt: fc.integer({ min: 0, max: 8 }),
  })
  .map(({ base, placement, headerAt }) => {
    if (placement === "keep") return { ...base, placement };
    const wad = WadFile.parse(base.bytes);
    const map = wad.maps[0]!;
    const sectors = wad.mapLump(map, "SECTORS")!;
    const filepos =
      placement === "header" ? headerAt : placement === "directory" ? base.bytes.length - sectors.size : wad.mapLump(map, "THINGS")!.filepos;
    return { ...base, bytes: withFilepos(base.bytes, sectors.index, filepos), placement };
  });

/** name8 字段的合法新值：1 到 8 个码点在 0x21..0x7e 的字符，长度边界（1 和 8）有额外权重。 */
export const validName8: fc.Arbitrary<string> = (() => {
  const ch = fc.integer({ min: 0x21, max: 0x7e }).map((c) => String.fromCharCode(c));
  const ofLength = (n: number) => fc.array(ch, { minLength: n, maxLength: n }).map((c) => c.join(""));
  return fc.oneof(ofLength(1), ofLength(8), fc.array(ch, { minLength: 1, maxLength: 8 }).map((c) => c.join("")));
})();

/** 按字段布局生成合法新值：整数取类型范围内的值（含边界），name8 取 validName8，count > 1 时取等长数组。 */
export function validValue(layout: FieldLayout): fc.Arbitrary<number | string | Array<number | string>> {
  const one: fc.Arbitrary<number | string> =
    layout.type === "int16"
      ? fc.oneof(fc.integer({ min: -32768, max: 32767 }), fc.constantFrom(-32768, -1, 0, 32767))
      : layout.type === "uint16"
        ? fc.oneof(fc.integer({ min: 0, max: 65535 }), fc.constantFrom(0, 1, 32768, 65535))
        : validName8;
  return layout.count > 1 ? fc.array(one, { minLength: layout.count, maxLength: layout.count }) : one;
}

export interface FieldWrite {
  readonly record: "Sector" | "Thing";
  readonly field: string;
  readonly value: number | string | Array<number | string>;
}

/**
 * 由 RECORD_LAYOUTS 推导的"字段 × 合法值"生成器：YAML 布局变化后自动跟随。
 * types 限定字段类型（默认全部）。
 */
export function fieldWrite(record: "Sector" | "Thing", types?: readonly FieldType[]): fc.Arbitrary<FieldWrite> {
  const fields = Object.entries(RECORD_LAYOUTS[record].fields).filter(([, l]) => !types || types.includes(l.type));
  return fc
    .constantFrom(...fields)
    .chain(([field, layout]) => validValue(layout).map((value): FieldWrite => ({ record, field, value })));
}

// ---------------------------------------------------------------------------
// patch-engine 的生成器
// ---------------------------------------------------------------------------

/** 可写记录及其单值字段，由 RECORD_LAYOUTS 推导。 */
const WRITABLE_FIELDS: ReadonlyArray<{ record: "Sector" | "Thing"; field: string; layout: FieldLayout }> = (["Sector", "Thing"] as const).flatMap((record) =>
  Object.entries(RECORD_LAYOUTS[record].fields as Record<string, FieldLayout>)
    .filter(([, l]) => l.count === 1)
    .map(([field, layout]) => ({ record, field, layout })),
);

/** 生成补丁时需要的输入概况：Doom 地图名（去重）和各记录的当前值。 */
export interface WadProfile {
  readonly mapNames: string[];
  /** 地图名（大写）→ 记录 → 当前记录值。同名地图只取第一张。 */
  readonly records: Record<string, Record<"Sector" | "Thing", Array<Record<string, number | string>>>>;
}

const profiles = new WeakMap<Uint8Array, WadProfile>();

/** 按数组实例缓存：同一个夹具数组只解析一次。调用方不得修改传入的数组。 */
export function profile(bytes: Uint8Array): WadProfile {
  const cached = profiles.get(bytes);
  if (cached) return cached;
  const p = buildProfile(bytes);
  profiles.set(bytes, p);
  return p;
}

/** 只把 ASCII A–Z 转小写。 */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function buildProfile(bytes: Uint8Array): WadProfile {
  const wad = WadFile.parse(bytes);
  const records: WadProfile["records"] = {};
  const mapNames: string[] = [];
  for (const m of wad.maps) {
    if (m.format !== "doom" || records[m.name.toUpperCase()]) continue;
    mapNames.push(m.name);
    const read = (record: "Sector" | "Thing") => {
      const lump = wad.mapLump(m, RECORD_LAYOUTS[record].lump);
      return lump ? (wad.readRecords(lump.index, record) as unknown as Array<Record<string, number | string>>) : [];
    };
    records[m.name.toUpperCase()] = { Sector: read("Sector"), Thing: read("Thing") };
  }
  return { mapNames, records };
}

export interface PatchForOptions {
  /** 只用 set 算子。 */
  readonly setOnly?: boolean;
  /**
   * 不主动生成越界值、超长名称和可能越界的无 clamp scale。
   * 取自输入的旧名称仍可能不是合法新值（例如生成样本里的不可打印字节），所以不保证应用成功。
   */
  readonly validOnly?: boolean;
}

/** 当前值样本：从某张地图的某条记录取值，没有记录时为 undefined。 */
const sampleCache = new WeakMap<WadProfile, Map<string, fc.Arbitrary<number | string | undefined>>>();

function sampleValue(p: WadProfile, record: "Sector" | "Thing", field: string): fc.Arbitrary<number | string | undefined> {
  let byField = sampleCache.get(p);
  if (!byField) sampleCache.set(p, (byField = new Map()));
  const k = `${record}.${field}`;
  const hit = byField.get(k);
  if (hit) return hit;
  // 去重：Freedoom 夹具有上千条记录，大多数字段只有几十种取值
  const all = [...new Set(p.mapNames.flatMap((m) => p.records[m.toUpperCase()]![record].map((r) => r[field]!)))];
  const arb = all.length === 0 ? fc.constant(undefined) : fc.constantFrom(...all);
  byField.set(k, arb);
  return arb;
}

function newValue(p: WadProfile, record: "Sector" | "Thing", field: string, layout: FieldLayout, validOnly: boolean): fc.Arbitrary<number | string> {
  const fresh = validValue(layout) as fc.Arbitrary<number | string>;
  const bad: fc.Arbitrary<number | string> =
    layout.type === "name8" ? fc.constantFrom("TOOLONGNAME", "") : layout.type === "int16" ? fc.constantFrom(40000, -40000) : fc.constantFrom(-1, 70000);
  // 约一半取某条记录的当前值，使 unchanged: true 的条目经常出现
  const fallback = layout.type === "name8" ? "FLAT1" : 0;
  const old = sampleValue(p, record, field).map((v) => v ?? fallback);
  const choices: Array<{ weight: number; arbitrary: fc.Arbitrary<number | string> }> = [
    { weight: 10, arbitrary: old },
    { weight: 9, arbitrary: fresh },
  ];
  if (!validOnly) choices.push({ weight: 1, arbitrary: bad });
  return fc.oneof(...choices);
}

function changeFor(p: WadProfile, record: "Sector" | "Thing", field: string, layout: FieldLayout, o: PatchForOptions): fc.Arbitrary<Record<string, unknown>> {
  const set = newValue(p, record, field, layout, o.validOnly ?? false).map((v) => ({ set: v }));
  if (o.setOnly || layout.type === "name8") return set;
  const [lo, hi] = layout.type === "int16" ? [-32768, 32767] : [0, 65535];
  const bounds = fc.tuple(fc.integer({ min: lo, max: hi }), fc.integer({ min: lo, max: hi })).map(([a, b]) => (a <= b ? [a, b] : [b, a]));
  const scale = fc.constantFrom(0, 0.5, 1, 1.5, 2, -1, 0.25);
  return fc.oneof(
    set,
    fc.record({ scale, clamp: bounds }),
    o.validOnly ? fc.record({ scale: fc.constantFrom(0, 0.5, 1, 0.25), clamp: bounds }) : fc.record({ scale }),
    fc.record({ clamp: bounds }),
  );
}

function conditionFor(p: WadProfile, record: "Sector" | "Thing", field: string, layout: FieldLayout): fc.Arbitrary<Record<string, unknown>> {
  const v = sampleValue(p, record, field);
  if (layout.type === "name8") {
    const name = fc.oneof(v.map((x) => (typeof x === "string" ? x : "FLAT1")), validName8);
    // 名称条件随机改大小写，结果不应变化
    const cased = name.chain((s) => fc.boolean().map((lower) => (lower ? asciiLower(s) : s)));
    return fc.oneof(
      cased.map((s) => ({ eq: s })),
      cased.map((s) => ({ ne: s })),
      fc.array(cased, { minLength: 1, maxLength: 3 }).map((list) => ({ in: list })),
    );
  }
  const num = fc.oneof(v.map((x) => (typeof x === "number" ? x : 0)), fc.integer({ min: -200, max: 400 }));
  return fc.oneof(
    ...(["eq", "ne", "lt", "lte", "gt", "gte"] as const).map((op) => num.map((n) => ({ [op]: n }))),
    fc.tuple(num, num).map(([a, b]) => ({ gte: Math.min(a, b), lte: Math.max(a, b) })),
    fc.array(num, { minLength: 1, maxLength: 3 }).map((list) => ({ in: list })),
  );
}

/**
 * 针对给定输入生成补丁：where / pin / all 三种选择器，约一半 set 取旧值，少量越界值（validOnly 时没有），
 * 随机带 allowProtected。后面的操作去掉前面操作已经写过的 (record, field)，所以不会出现 CONFLICT_FIELD。
 */
const patchArbs = new WeakMap<Uint8Array, Map<string, fc.Arbitrary<Record<string, unknown>>>>();

export function patchFor(bytes: Uint8Array, o: PatchForOptions = {}): fc.Arbitrary<Record<string, unknown>> {
  // 按数组实例和选项缓存，夹具上不必每次运行都重建生成器
  const k = `${o.setOnly ?? false}/${o.validOnly ?? false}`;
  let byOpts = patchArbs.get(bytes);
  if (!byOpts) patchArbs.set(bytes, (byOpts = new Map()));
  const hit = byOpts.get(k);
  if (hit) return hit;
  const arb = buildPatchFor(bytes, o);
  byOpts.set(k, arb);
  return arb;
}

function buildPatchFor(bytes: Uint8Array, o: PatchForOptions): fc.Arbitrary<Record<string, unknown>> {
  const p = profile(bytes);
  if (p.mapNames.length === 0) throw new Error("patchFor needs a WAD with at least one Doom map");
  const maps = fc.oneof(fc.constant<"*" | string[]>("*"), fc.subarray(p.mapNames, { minLength: 1 }));
  const operation = (targetMaps: "*" | string[]) =>
    fc.constantFrom<"Sector" | "Thing">("Sector", "Thing").chain((record) => {
      const fields = WRITABLE_FIELDS.filter((f) => f.record === record);
      const pinMaps = targetMaps === "*" ? p.mapNames : targetMaps;
      const select = fc.oneof(
        fc.subarray(fields, { minLength: 1, maxLength: 2 }).chain((fs) =>
          fc.tuple(...fs.map((f) => conditionFor(p, record, f.field, f.layout))).map((conds) => ({
            record,
            where: Object.fromEntries(fs.map((f, i) => [f.field, conds[i]])),
          })),
        ),
        fc.constantFrom(...pinMaps).chain((map) => {
          const n = p.records[map.toUpperCase()]![record].length;
          return fc
            .record({
              expectedIndex: n > 0 ? fc.integer({ min: 0, max: n - 1 }) : fc.constant(0),
              fingerprint: fc.option(fc.record({ tag: fc.integer({ min: 0, max: 99 }), note: fc.string({ maxLength: 4 }) }), { nil: undefined }),
            })
            .map(({ expectedIndex, fingerprint }) => ({ record, pin: { map, expectedIndex, ...(fingerprint ? { fingerprint } : {}) } }));
        }),
        fc.constant({ record, all: true as const }),
      );
      const change = fc
        .subarray(fields, { minLength: 1, maxLength: 3 })
        .chain((fs) => fc.tuple(...fs.map((f) => changeFor(p, record, f.field, f.layout, o))).map((cs) => fs.map((f, i) => [f.field, cs[i]!] as const)));
      return fc.record({ select, change });
    });
  return maps.chain((targetMaps) =>
    fc
      .record({
        ops: fc.array(operation(targetMaps), { minLength: 1, maxLength: 3 }),
        allowProtected: fc.boolean(),
        name: fc.constantFrom("dim", "Haunted House", "Ünïcode 😀"),
      })
      .map(({ ops, allowProtected, name }) => {
        const used = new Set<string>();
        const operations = ops
          .map((op) => {
            const change: Record<string, unknown> = {};
            for (const [field, ch] of op.change) {
              const k = `${op.select.record}.${field}`;
              if (used.has(k)) continue;
              used.add(k);
              change[field] = ch;
            }
            return { select: op.select, change };
          })
          .filter((op) => Object.keys(op.change).length > 0)
          .map((op, i) => ({ id: `op${i}`, ...op }));
        return {
          schemaVersion: 1,
          name,
          target: { format: "wad", maps: targetMaps },
          ...(allowProtected ? { allowProtected: ["sector-special-nonzero"] } : {}),
          operations,
        };
      }),
  );
}

/** 只含 set 的补丁。 */
export function setOnlyPatchFor(bytes: Uint8Array, o: Omit<PatchForOptions, "setOnly"> = {}): fc.Arbitrary<Record<string, unknown>> {
  return patchFor(bytes, { ...o, setOnly: true });
}

/** 两张同名地图（各带全部数据 Lump）的 WAD：作用域 id 为 <name>@<markerIndex>，pin 该名称应为 CONFLICT_AMBIGUOUS。 */
export const dupMapWad: fc.Arbitrary<{ bytes: Uint8Array; name: string; sectorCount: number }> = fc
  .record({
    name: fc.constantFrom("MAP01", "E1M1"),
    sectorCount: fc.integer({ min: 1, max: 4 }),
    seed: fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 20 }),
    between: fc.array(lumpInput, { maxLength: 2 }),
  })
  .map(({ name, sectorCount, seed, between }) => {
    const map = (): LumpInput[] => [
      { name, data: new Uint8Array(0) },
      ...MAP_DATA_LUMPS.map((n) => ({
        name: n,
        data: n === "SECTORS" ? sectorBytes(sectorCount, seed) : n === "THINGS" ? thingBytes(2, seed) : Uint8Array.of(...seed.slice(0, 3)),
      })),
    ];
    const strip = (l: LumpInput): LumpInput => ({ name: "X" + l.name.slice(0, 7), data: l.data });
    return { bytes: buildWad({ kind: "PWAD", lumps: [...map(), ...between.map(strip), ...map()] }), name, sectorCount };
  });

/**
 * mapWad 的变体：把第一张地图某个扇区的 name8 字段改成"第一个 NUL 之后还有非零字节"。
 * 返回字节和被改的位置（字段名来自布局）。
 */
export const name8TailWad: fc.Arbitrary<{ bytes: Uint8Array; map: string; index: number; field: string }> = fc
  .record({
    base: mapWad,
    pick: fc.nat(),
    field: fc.constantFrom(...Object.entries(RECORD_LAYOUTS.Sector.fields).filter(([, l]) => l.type === "name8").map(([f]) => f)),
    nulAt: fc.integer({ min: 0, max: 6 }),
    tail: fc.integer({ min: 1, max: 255 }),
    tailAt: fc.nat(),
  })
  .map(({ base, pick, field, nulAt, tail, tailAt }) => {
    const wad = WadFile.parse(base.bytes);
    const m = wad.maps[0]!;
    const lump = wad.mapLump(m, "SECTORS")!.index;
    const index = pick % base.sectorCount;
    const s = wad.fieldSpan(lump, "Sector", index, field as "floorpic");
    const out = base.bytes.slice();
    out[s.start + nulAt] = 0;
    out[s.start + nulAt + 1 + (tailAt % (7 - nulAt))] = tail;
    return { bytes: out, map: m.name, index, field };
  });
