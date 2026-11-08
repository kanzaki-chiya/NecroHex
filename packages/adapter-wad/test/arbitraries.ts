import fc from "fast-check";
import { buildWad, MAP_DATA_LUMPS, type LumpInput } from "../src/index.ts";

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

function sectorBytes(count: number, seed: readonly number[]): Uint8Array {
  const out = new Uint8Array(count * SECTOR_SIZE);
  for (let i = 0; i < out.length; i++) out[i] = seed[i % seed.length]!;
  return out;
}

/** 带一张标准结构地图的 WAD：标记 + 数据 Lump，前后夹杂无关 Lump 和间隙。 */
export const mapWad: fc.Arbitrary<{ bytes: Uint8Array; sectorCount: number }> = fc
  .record({
    sectorCount: fc.integer({ min: 1, max: 6 }),
    seed: fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 30 }),
    before: fc.array(lumpInput, { maxLength: 3 }),
    after: fc.array(lumpInput, { maxLength: 3 }),
    mapName: fc.constantFrom("MAP01", "MAP32", "E1M1", "E4M9"),
    gap: fc.option(bytes(6), { nil: undefined }),
  })
  .map(({ sectorCount, seed, before, after, mapName, gap }) => {
    // 前后夹杂的随机 Lump 一律改名为 X 开头，避免与固定地图的标记或数据 Lump 冲突
    const strip = (l: LumpInput): LumpInput => ({
      name: "X" + l.name.slice(0, 7),
      data: l.data,
      ...(l.gapBefore ? { gapBefore: l.gapBefore } : {}),
    });
    const dataLumps: LumpInput[] = MAP_DATA_LUMPS.map((name) => ({
      name,
      data: name === "SECTORS" ? sectorBytes(sectorCount, seed) : Uint8Array.of(...seed.slice(0, 5)),
    }));
    const lumps = [...before.map(strip), { name: mapName, data: new Uint8Array(0) }, ...dataLumps, ...after.map(strip)];
    return { bytes: buildWad({ kind: "PWAD", lumps, ...(gap ? { gapBeforeDirectory: gap } : {}) }), sectorCount };
  });
