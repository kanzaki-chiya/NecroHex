import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAP_DATA_LUMPS, WadFile } from "../src/index.ts";
import { changedIndices, equalBytes, insideAny } from "./helpers.ts";

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
    }
    expect(wad.regions.gaps).toEqual([]);
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
      for (const s of l.sidenum) expect(s).toBeLessThan(sides.length);
    }
    for (const s of sides) expect(s.sector).toBeLessThan(sectors.length);
    // 记录区间恰好铺满 Lump，没有余字节
    for (const [name, size] of [["SECTORS", 26], ["THINGS", 10], ["LINEDEFS", 14], ["SIDEDEFS", 30], ["VERTEXES", 4]] as const) {
      expect(wad.mapLump(map, name)!.size % size).toBe(0);
    }
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
  const present = existsSync(path);
  const run = it.skipIf(!present);

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
    }
  });
});
