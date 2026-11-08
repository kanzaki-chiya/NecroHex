import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateRecordsSource, OUTPUT_PATH, SPEC_PATH } from "../scripts/generate-records.ts";
import { buildWad, RECORD_LAYOUTS, WadFile, type RecordName } from "../src/index.ts";

function sectorBytes(): Uint8Array {
  const raw = new Uint8Array(26 * 2);
  const v = new DataView(raw.buffer);
  v.setInt16(0, -8, true); // floorheight
  v.setInt16(2, 128, true); // ceilingheight
  raw.set([...Buffer.from("FLOOR4_8")], 4);
  raw.set([...Buffer.from("CEIL3_5\0")], 12);
  v.setInt16(20, 160, true); // lightlevel
  v.setInt16(22, 9, true); // special
  v.setInt16(24, 7, true); // tag
  return raw;
}

/** 裸 SECTORS，没有地图标记：读取接口可用，setField 会被拒绝（OUTSIDE_MAP_SCOPE）。 */
function sectorWad(): { wad: WadFile; lump: number; raw: Uint8Array } {
  const raw = sectorBytes();
  const wad = WadFile.parse(buildWad({ kind: "PWAD", lumps: [{ name: "SECTORS", data: raw }] }));
  return { wad, lump: 0, raw };
}

/** SECTORS 放进 MAP01 的地图作用域；Lump 下标从目录里取，不依赖固定下标。 */
function mappedSectorWad(): { wad: WadFile; lump: number; raw: Uint8Array } {
  const raw = sectorBytes();
  const wad = WadFile.parse(
    buildWad({ kind: "PWAD", lumps: [{ name: "MAP01", data: new Uint8Array(0) }, { name: "SECTORS", data: raw }] }),
  );
  return { wad, lump: wad.mapLump(wad.findMap("MAP01")!, "SECTORS")!.index, raw };
}

describe("生成的记录层", () => {
  it("generated/records.ts 与 YAML 同步", () => {
    const expected = generateRecordsSource(readFileSync(SPEC_PATH, "utf8"));
    expect(readFileSync(OUTPUT_PATH, "utf8")).toBe(expected);
  });

  it("记录大小符合设计文档", () => {
    const sizes = Object.fromEntries(Object.entries(RECORD_LAYOUTS).map(([k, v]) => [k, v.size]));
    expect(sizes).toEqual({ Sector: 26, Thing: 10, Linedef: 14, Sidedef: 30, Vertex: 4 });
  });

  it("读取 Sector 的全部字段", () => {
    const { wad, lump } = sectorWad();
    expect(wad.recordCount(lump, "Sector")).toBe(2);
    expect(wad.readRecord(lump, "Sector", 0)).toEqual({
      floorheight: -8,
      ceilingheight: 128,
      floorpic: "FLOOR4_8",
      ceilingpic: "CEIL3_5",
      lightlevel: 160,
      special: 9,
      tag: 7,
    });
  });

  it("读取 Linedef 的数组字段和无符号字段", () => {
    const raw = new Uint8Array(14);
    const v = new DataView(raw.buffer);
    v.setUint16(0, 65535, true);
    v.setUint16(4, 0x8001, true);
    v.setInt16(10, -1, true);
    v.setInt16(12, 3, true);
    const wad = WadFile.parse(buildWad({ kind: "PWAD", lumps: [{ name: "LINEDEFS", data: raw }] }));
    const l = wad.readRecord(0, "Linedef", 0);
    expect(l.v1).toBe(65535);
    expect(l.flags).toBe(0x8001);
    expect(l.sidenum).toEqual([-1, 3]);
  });

  it("尾部不足一条记录的字节不计入记录", () => {
    const wad = WadFile.parse(buildWad({ kind: "PWAD", lumps: [{ name: "THINGS", data: new Uint8Array(25) }] }));
    expect(wad.recordCount(0, "Thing")).toBe(2);
    expect(() => wad.readRecord(0, "Thing", 2)).toThrow(RangeError);
  });

  it("Lump 名称与记录类型不符时拒绝读取", () => {
    const { wad } = sectorWad();
    expect(() => wad.readRecords(0, "Thing")).toThrow(TypeError);
  });

  it("解析不校验：越界取值也能读出", () => {
    const raw = new Uint8Array(26);
    raw.fill(0xff);
    const wad = WadFile.parse(buildWad({ kind: "PWAD", lumps: [{ name: "SECTORS", data: raw }] }));
    expect(wad.readRecord(0, "Sector", 0).lightlevel).toBe(-1);
  });
});

describe("字段写入", () => {
  it("写入后读取到新值，字节只在字段区间变化，基础缓冲不变", () => {
    const { wad, lump, raw } = mappedSectorWad();
    const before = wad.original();
    const written = wad.setField(lump, "Sector", 1, "floorpic", "BLOOD1");
    expect(written).toEqual(wad.fieldSpan(lump, "Sector", 1, "floorpic"));
    expect(wad.readRecord(lump, "Sector", 1).floorpic).toBe("BLOOD1");
    expect(wad.readRecord(lump, "Sector", 0)).toEqual(mappedSectorWad().wad.readRecord(lump, "Sector", 0));
    expect(wad.original()).toEqual(before);
    expect(wad.dirtySpans()).toEqual([written]);
    const out = wad.serialize();
    expect([...out.slice(written.start, written.end)]).toEqual([...Buffer.from("BLOOD1\0\0")]);
    expect(raw.length).toBe(52);
  });

  it("新值越界或类型错误时抛出，且不留下痕迹", () => {
    const { wad, lump } = mappedSectorWad();
    expect(() => wad.setField(lump, "Sector", 0, "lightlevel", 40000)).toThrow(RangeError);
    expect(() => wad.setField(lump, "Sector", 0, "lightlevel", 1.5)).toThrow(TypeError);
    expect(() => wad.setField(lump, "Sector", 0, "floorpic", "TOOLONGNAME")).toThrow(RangeError);
    expect(() => wad.setField(lump, "Sector", 0, "floorpic", "bad\u0000")).toThrow(RangeError);
    expect(() => wad.setField(lump, "Sector", 5, "tag", 1)).toThrow(RangeError);
    expect(wad.dirtySpans()).toEqual([]);
  });

  it("只读记录类型拒绝写入", () => {
    const wad = WadFile.parse(buildWad({ kind: "PWAD", lumps: [{ name: "VERTEXES", data: new Uint8Array(4) }] }));
    const record: RecordName = "Vertex";
    expect(() => wad.setField(0, record as "Sector", 0, "tag", 1)).toThrow();
  });
});
