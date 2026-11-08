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
