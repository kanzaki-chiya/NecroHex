import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWad, MAP_DATA_LUMPS, NO_INDEX, WadFile, WadRecordError } from "../src/index.ts";
import { changedIndices, equalBytes, haveFreedoom, insideAny, legacyMaps, mapsWithoutFormat, withFilepos } from "./helpers.ts";

const fixtures = resolve(import.meta.dirname, "../fixtures");
const subset = resolve(fixtures, "freedoom/freedoom2-map01-02.wad");
const cached = ["freedoom1.wad", "freedoom2.wad"].map((n) => resolve(fixtures, "cache", n));

function load(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

describe("Freedoom 夹具（PWAD 子集）", () => {
  const bytes = load(subset);
  const wad = WadFile.parse(bytes);

  it("I-1 逐字节往返", () => {
    expect(equalBytes(wad.serialize(), bytes)).toBe(true);
  });

  it("解析出两张完整地图和无关 Lump", () => {
    expect(wad.kind).toBe("PWAD");
    expect(wad.lumps.map((l) => l.name).slice(0, 2)).toEqual(["PLAYPAL", "ENDOOM"]);
    expect(wad.maps.map((m) => m.name)).toEqual(["MAP01", "MAP02"]);
    for (const m of wad.maps) {
      expect(Object.keys(m.lumps).sort()).toEqual([...MAP_DATA_LUMPS].sort());
      expect(wad.lumps[m.markerIndex]!.isMarker).toBe(true);
      expect(m.format).toBe("doom");
    }
    expect(wad.regions.gaps).toEqual([]);
  });

  it("地图格式识别没有改变夹具的作用域：format 为 doom，其余与旧规则逐项相同", () => {
    expect(wad.maps.every((m) => m.format === "doom")).toBe(true);
    expect(mapsWithoutFormat(wad)).toEqual(legacyMaps(wad));
  });

  it("MAP01 的记录可读且彼此一致", () => {
    const map = wad.findMap("MAP01")!;
    const sectors = wad.readRecords(wad.mapLump(map, "SECTORS")!.index, "Sector");
    const things = wad.readRecords(wad.mapLump(map, "THINGS")!.index, "Thing");
    const lines = wad.readRecords(wad.mapLump(map, "LINEDEFS")!.index, "Linedef");
    const sides = wad.readRecords(wad.mapLump(map, "SIDEDEFS")!.index, "Sidedef");
    const verts = wad.readRecords(wad.mapLump(map, "VERTEXES")!.index, "Vertex");
    expect(sectors.length).toBeGreaterThan(0);
    expect(things.some((t) => t.type === 1)).toBe(true); // 玩家 1 出生点
    for (const l of lines) {
      expect(l.v1).toBeLessThan(verts.length);
      expect(l.v2).toBeLessThan(verts.length);
      // 前面必须有；背面为 0xFFFF 表示单面线段
      expect(l.sidenum[0]).toBeLessThan(sides.length);
      if (l.sidenum[1] !== NO_INDEX) expect(l.sidenum[1]).toBeLessThan(sides.length);
    }
    expect(lines.some((l) => l.sidenum[1] === NO_INDEX)).toBe(true);
    expect(lines.every((l) => l.sidenum.every((s) => s >= 0))).toBe(true);
    for (const s of sides) expect(s.sector).toBeLessThan(sectors.length);
    // 记录区间恰好铺满 Lump，没有余字节
    for (const [name, size] of [["SECTORS", 26], ["THINGS", 10], ["LINEDEFS", 14], ["SIDEDEFS", 30], ["VERTEXES", 4]] as const) {
      expect(wad.mapLump(map, name)!.size % size).toBe(0);
    }
  });

  it("MAP01 的 SECTORS 目录项指向文件头时，setField 被拒绝且不留痕迹（SECTORS 仍在地图作用域内）", () => {
    const sectorsIndex = wad.mapLump(wad.findMap("MAP01")!, "SECTORS")!.index;
    const broken = withFilepos(bytes, sectorsIndex, 0);
    const w = WadFile.parse(broken);
    expect(w.findMap("MAP01")!.dataIndices).toContain(sectorsIndex);
    expect(() => w.setField(sectorsIndex, "Sector", 0, "floorheight", 0x4441)).toThrow(WadRecordError);
    expect(w.dirtySpans()).toEqual([]);
    expect(equalBytes(w.serialize(), broken)).toBe(true);
  });

  it("在 MAP01 的数据 Lump 之后追加 BEHAVIOR 得到 Hexen 变体：MAP01 的记录接口被拒绝，MAP02 不受影响", () => {
    const source = wad.original();
    const lumps = wad.lumps.map((l) => ({
      name: l.name,
      nameBytes: source.slice(l.nameSpan.start, l.nameSpan.end),
      data: l.dataSpan ? source.slice(l.dataSpan.start, l.dataSpan.end) : new Uint8Array(0),
    }));
    const map01 = wad.findMap("MAP01")!;
    const lastData = map01.dataIndices[map01.dataIndices.length - 1]!;
    lumps.splice(lastData + 1, 0, { name: "BEHAVIOR", nameBytes: Uint8Array.from([...Buffer.from("BEHAVIOR")]), data: new Uint8Array(8) });
    const hexenBytes = buildWad({ kind: "PWAD", lumps });
    const hexen = WadFile.parse(hexenBytes);
    expect(hexen.findMap("MAP01")!.format).toBe("hexen");
    expect(hexen.findMap("MAP02")!.format).toBe("doom");
    const things = hexen.mapLump(hexen.findMap("MAP01")!, "THINGS")!.index;
    const code = (call: () => unknown): string | undefined => {
      try {
        call();
      } catch (e) {
        return e instanceof WadRecordError ? e.code : "OTHER";
      }
      return undefined;
    };
    expect(code(() => hexen.recordCount(things, "Thing"))).toBe("UNSUPPORTED_MAP_FORMAT");
    expect(code(() => hexen.readRecords(things, "Thing"))).toBe("UNSUPPORTED_MAP_FORMAT");
    expect(code(() => hexen.setField(things, "Thing", 0, "x", 1))).toBe("UNSUPPORTED_MAP_FORMAT");
    expect(hexen.dirtySpans()).toEqual([]);
    expect(equalBytes(hexen.serialize(), hexenBytes)).toBe(true);
    // MAP02 仍可读
    const things2 = hexen.mapLump(hexen.findMap("MAP02")!, "THINGS")!.index;
    expect(hexen.recordCount(things2, "Thing")).toBe(wad.recordCount(wad.mapLump(wad.findMap("MAP02")!, "THINGS")!.index, "Thing"));
  });

  it("I-3 改一个扇区字段，字节只在该字段区间变化", () => {
    const w = WadFile.parse(bytes);
    const map = w.findMap("MAP01")!;
    const lump = w.mapLump(map, "SECTORS")!.index;
    const original = w.readRecord(lump, "Sector", 0);
    const written = [
      w.setField(lump, "Sector", 0, "lightlevel", original.lightlevel === 96 ? 97 : 96),
      w.setField(lump, "Sector", 0, "floorpic", "BLOOD1"),
    ];
    const out = w.serialize();
    const changed = changedIndices(bytes, out);
    expect(changed.length).toBeGreaterThan(0);
    for (const i of changed) expect(insideAny(i, written)).toBe(true);
    expect(w.readRecord(lump, "Sector", 0).floorpic).toBe("BLOOD1");
    const again = WadFile.parse(out);
    expect(again.readRecord(lump, "Sector", 0)).toEqual(w.readRecord(lump, "Sector", 0));
  });
});

describe.each(cached)("完整 Freedoom IWAD %s", (path) => {
  const run = it.skipIf(!haveFreedoom(path));

  run("I-1 逐字节往返", () => {
    const bytes = load(path);
    expect(equalBytes(WadFile.parse(bytes).serialize(), bytes)).toBe(true);
  });

  run("目录、间隙和地图作用域", () => {
    const wad = WadFile.parse(load(path));
    expect(wad.kind).toBe("IWAD");
    expect(wad.maps.length).toBeGreaterThanOrEqual(9);
    expect(wad.lumps.some((l) => l.isMarker)).toBe(true);
    for (const l of wad.lumps) expect(l.issues).toEqual([]);
    for (const m of wad.maps) {
      expect(wad.mapLump(m, "THINGS")).toBeDefined();
      expect(wad.mapLump(m, "SECTORS")).toBeDefined();
      const sectors = wad.mapLump(m, "SECTORS")!;
      expect(sectors.size % 26).toBe(0);
      expect(m.format).toBe("doom");
    }
    expect(mapsWithoutFormat(wad)).toEqual(legacyMaps(wad));
  });
});
