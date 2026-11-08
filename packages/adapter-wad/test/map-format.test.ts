import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildWad, RECORD_LAYOUTS, WadFile, WadRecordError, type LumpInput, type RecordName } from "../src/index.ts";
import { equalBytes } from "./helpers.ts";

const empty = new Uint8Array(0);

/** 记录 Lump → 记录类型。 */
const RECORD_LUMPS: ReadonlyArray<readonly [string, RecordName]> = [
  ["THINGS", "Thing"],
  ["LINEDEFS", "Linedef"],
  ["SIDEDEFS", "Sidedef"],
  ["VERTEXES", "Vertex"],
  ["SECTORS", "Sector"],
];

type Variant = "doom" | "hexen" | "hexen-20-byte-things";

/**
 * 在一张 Doom 结构的地图上做格式变体：
 * doom：对照；hexen：BEHAVIOR 出现在数据 Lump 之间的任意位置；
 * hexen-20-byte-things：BEHAVIOR 加上 20 字节一条的 THINGS，按 Doom 布局会读出错误的条数（只用来制造反例，不解析内容）。
 */
function mapLumps(variant: Variant, counts: number, behaviorAt: number): LumpInput[] {
  const sizeOf = (name: string): number => {
    if (name === "THINGS") return variant === "hexen-20-byte-things" ? 20 * counts : 10 * counts;
    const rec = RECORD_LUMPS.find(([l]) => l === name);
    return rec ? RECORD_LAYOUTS[rec[1]].size * counts : 6;
  };
  const names = ["THINGS", "LINEDEFS", "SIDEDEFS", "VERTEXES", "SEGS", "SSECTORS", "NODES", "SECTORS", "REJECT", "BLOCKMAP"];
  const data: LumpInput[] = names.map((name) => ({ name, data: new Uint8Array(sizeOf(name)).fill(name.length) }));
  if (variant !== "doom") data.splice(behaviorAt % (data.length + 1), 0, { name: "BEHAVIOR", data: new Uint8Array(8).fill(7) });
  return [{ name: "MAP01", data: empty }, ...data];
}

const variants = fc.record({
  variant: fc.constantFrom<Variant>("doom", "hexen", "hexen-20-byte-things"),
  counts: fc.integer({ min: 1, max: 4 }),
  behaviorAt: fc.nat(10),
});

describe("非 Doom 格式地图拒绝按 Doom 布局访问", () => {
  it("hexen：六个记录接口都抛 UNSUPPORTED_MAP_FORMAT；doom：行为不变", () => {
    const seen = new Set<Variant>();
    fc.assert(
      fc.property(variants, ({ variant, counts, behaviorAt }) => {
        seen.add(variant);
        const input = buildWad({ kind: "PWAD", lumps: mapLumps(variant, counts, behaviorAt) });
        const wad = WadFile.parse(input);
        expect(wad.maps).toHaveLength(1);
        const map = wad.maps[0]!;
        expect(map.format).toBe(variant === "doom" ? "doom" : "hexen");

        for (const [lumpName, record] of RECORD_LUMPS) {
          const lump = wad.mapLump(map, lumpName)!;
          const firstField = Object.keys(RECORD_LAYOUTS[record].fields)[0] as "x";
          const calls: Array<[string, () => unknown]> = [
            ["recordCount", () => wad.recordCount(lump.index, record)],
            ["recordSpan", () => wad.recordSpan(lump.index, record, 0)],
            ["fieldSpan", () => wad.fieldSpan(lump.index, record as "Thing", 0, firstField)],
            ["readRecord", () => wad.readRecord(lump.index, record, 0)],
            ["readRecords", () => wad.readRecords(lump.index, record)],
          ];
          if (record === "Sector" || record === "Thing") {
            const writable = record === "Sector" ? "tag" : "x";
            calls.push(["setField", () => wad.setField(lump.index, record as "Thing", 0, writable as "x", 1)]);
          }
          for (const [label, call] of calls) {
            if (variant === "doom") {
              expect(call, `${label} ${lumpName}`).not.toThrow();
            } else {
              let thrown: unknown;
              try {
                call();
              } catch (e) {
                thrown = e;
              }
              expect(thrown, `${label} ${lumpName}`).toBeInstanceOf(WadRecordError);
              expect((thrown as WadRecordError).code).toBe("UNSUPPORTED_MAP_FORMAT");
              expect((thrown as WadRecordError).lumpIndex).toBe(lump.index);
            }
          }
          if (variant !== "doom") {
            // Lump 名称与记录类型不符仍先报 TypeError：检查顺序是下标 → 名称 → 格式
            const other = RECORD_LUMPS.find(([, r]) => r !== record)![1];
            expect(() => wad.recordCount(lump.index, other)).toThrow(TypeError);
          }
        }

        if (variant === "doom") {
          const things = wad.mapLump(map, "THINGS")!;
          expect(wad.recordCount(things.index, "Thing")).toBe(Math.floor(things.size / 10));
        } else {
          // 拒绝的 setField 不留痕迹；其余接口照常工作，I-1 照常成立
          expect(wad.dirtySpans()).toEqual([]);
          expect(equalBytes(wad.serialize(), input)).toBe(true);
        }
        expect(equalBytes(wad.original(), input)).toBe(true);
        for (const i of map.dataIndices) expect(wad.lumpBytes(i).length).toBe(wad.lumps[i]!.size);
        expect(wad.regions.header).toEqual({ start: 0, end: 12 });
      }),
      { numRuns: 150 },
    );
    expect([...seen].sort()).toEqual(["doom", "hexen", "hexen-20-byte-things"]);
  });

  it("doom 地图上 setField 写入后 dirtySpans 非空；hexen 地图上被拒绝的 setField 之后 dirtySpans 为空", () => {
    const doom = WadFile.parse(buildWad({ kind: "PWAD", lumps: mapLumps("doom", 2, 0) }));
    const hexen = WadFile.parse(buildWad({ kind: "PWAD", lumps: mapLumps("hexen", 2, 3) }));
    const sectors = (w: WadFile) => w.mapLump(w.maps[0]!, "SECTORS")!.index;
    doom.setField(sectors(doom), "Sector", 0, "tag", 3);
    expect(doom.dirtySpans()).toHaveLength(1);
    expect(() => hexen.setField(sectors(hexen), "Sector", 0, "tag", 3)).toThrow(WadRecordError);
    expect(hexen.dirtySpans()).toEqual([]);
  });

  it("UDMF：作用域内没有记录 Lump 名；ENDMAP 之后的 THINGS 不属于任何作用域，可读不可写", () => {
    const input = buildWad({
      kind: "PWAD",
      lumps: [
        { name: "MYMAP", data: empty },
        { name: "TEXTMAP", data: new Uint8Array(8) },
        { name: "ZNODES", data: new Uint8Array(4) },
        { name: "REJECT", data: new Uint8Array(4) },
        { name: "ENDMAP", data: empty },
        { name: "THINGS", data: new Uint8Array(20) },
      ],
    });
    const wad = WadFile.parse(input);
    expect(wad.maps.map((m) => [m.format, m.dataIndices])).toEqual([["udmf", [1, 2, 3, 4]]]);
    // UDMF 作用域里的 Lump 没有对应的记录类型：名称不符
    for (const i of wad.maps[0]!.dataIndices) expect(() => wad.recordCount(i, "Thing")).toThrow(TypeError);
    // 作用域之外的 THINGS：读取照常，写入被拒绝
    expect(wad.recordCount(5, "Thing")).toBe(2);
    let thrown: unknown;
    try {
      wad.setField(5, "Thing", 0, "x", 1);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as WadRecordError).code).toBe("OUTSIDE_MAP_SCOPE");
    expect(wad.dirtySpans()).toEqual([]);
    expect(equalBytes(wad.serialize(), input)).toBe(true);
  });
});
