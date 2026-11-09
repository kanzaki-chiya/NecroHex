import { applyPatch, planPatch } from "@necrohex/core";
import { describe, expect, it } from "vitest";
import { buildWad, MAP_DATA_LUMPS, RECORD_LAYOUTS, wadAdapter, WadFile, type LumpInput } from "../src/index.ts";
import { withFilepos } from "./helpers.ts";

const empty = new Uint8Array(0);

/** n 个扇区：lightlevel = 100 + i，special = i，floorpic 由 pics 给出（原始 8 字节）。 */
function sectors(pics: Uint8Array[]): Uint8Array {
  const raw = new Uint8Array(26 * pics.length);
  const v = new DataView(raw.buffer);
  pics.forEach((pic, i) => {
    raw.set(pic, i * 26 + 4);
    v.setInt16(i * 26 + 20, 100 + i, true);
    v.setInt16(i * 26 + 22, i, true);
  });
  return raw;
}

function name(s: string, tail: number[] = []): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  tail.forEach((b, i) => (out[s.length + 1 + i] = b));
  return out;
}

function map(marker: string, sectorData: Uint8Array): LumpInput[] {
  return [{ name: marker, data: empty }, ...MAP_DATA_LUMPS.map((n) => ({ name: n, data: n === "SECTORS" ? sectorData : n === "THINGS" ? new Uint8Array(20) : Uint8Array.of(1, 2, 3, 4) }))];
}

const loc = (scope: string, index: number, record = "Sector") => ({ scope, record, index });

describe("schema", () => {
  it("由 RECORD_LAYOUTS 推导：单值整数为 int，name8 为 name，多值为 other；只有 Sector、Thing 可写", () => {
    const src = wadAdapter.open(buildWad({ kind: "PWAD", lumps: map("MAP01", sectors([name("FLAT1")])) }));
    expect(Object.keys(src.schema).sort()).toEqual(Object.keys(RECORD_LAYOUTS).sort());
    expect(src.schema.Sector).toEqual({
      writable: true,
      fields: { floorheight: "int", ceilingheight: "int", floorpic: "name", ceilingpic: "name", lightlevel: "int", special: "int", tag: "int" },
    });
    expect(src.schema.Thing!.writable).toBe(true);
    expect(src.schema.Linedef).toEqual({ writable: false, fields: { v1: "int", v2: "int", flags: "int", special: "int", tag: "int", sidenum: "other" } });
    expect(src.schema.Sidedef!.writable).toBe(false);
    expect(src.schema.Vertex!.writable).toBe(false);
  });
});

describe("作用域", () => {
  it("名称唯一时 id 为名称；同名时为 <name>@<markerIndex>；只列 Doom 格式", () => {
    const lumps = [
      ...map("MAP01", sectors([name("A")])),
      ...map("MAP02", sectors([name("B")])),
      ...map("MAP01", sectors([name("C")])),
      { name: "MAP03", data: empty },
      { name: "THINGS", data: new Uint8Array(20) },
      { name: "BEHAVIOR", data: new Uint8Array(4) },
    ];
    const src = wadAdapter.open(buildWad({ kind: "PWAD", lumps }));
    expect(src.scopes()).toEqual([
      { id: "MAP01@0", name: "MAP01" },
      { id: "MAP02", name: "MAP02" },
      { id: "MAP01@22", name: "MAP01" },
    ]);
    expect(src.readField(loc("MAP01@22", 0), "floorpic")).toBe("C");
  });

  it("pin 同名地图为 CONFLICT_AMBIGUOUS", () => {
    const bytes = buildWad({ kind: "PWAD", lumps: [...map("MAP01", sectors([name("A")])), ...map("MAP01", sectors([name("C")]))] });
    const r = planPatch(
      bytes,
      { schemaVersion: 1, name: "p", target: { format: "wad", maps: "*" }, operations: [{ id: "x", select: { record: "Sector", pin: { map: "map01", expectedIndex: 0 } }, change: { tag: { set: 1 } } }] },
      wadAdapter,
    );
    expect(r.issues).toEqual([expect.objectContaining({ code: "CONFLICT_AMBIGUOUS", operationId: "x" })]);
  });

  it("缺 Lump 时 recordCount 为 0", () => {
    const src = wadAdapter.open(buildWad({ kind: "PWAD", lumps: [{ name: "MAP01", data: empty }, { name: "THINGS", data: new Uint8Array(10) }] }));
    expect(src.recordCount("MAP01", "Sector")).toBe(0);
    expect(src.recordCount("MAP01", "Thing")).toBe(1);
  });

  it("open 复制输入", () => {
    const bytes = buildWad({ kind: "PWAD", lumps: map("MAP01", sectors([name("FLAT1")])) });
    const src = wadAdapter.open(bytes);
    const before = src.readField(loc("MAP01", 0), "lightlevel");
    const at = src.fieldSpan(loc("MAP01", 0), "lightlevel").start;
    bytes[at] = 0x7f;
    expect(src.readField(loc("MAP01", 0), "lightlevel")).toBe(before);
  });
});

describe("canRestore", () => {
  it("name8 第一个 NUL 后有非零字节时为 false，其余为 true", () => {
    const src = wadAdapter.open(buildWad({ kind: "PWAD", lumps: map("MAP01", sectors([name("FLAT1"), name("AB", [0, 7]), name("ABCDEFGH"), name("")])) }));
    expect(src.canRestore(loc("MAP01", 0), "floorpic")).toBe(true);
    expect(src.canRestore(loc("MAP01", 1), "floorpic")).toBe(false);
    expect(src.canRestore(loc("MAP01", 2), "floorpic")).toBe(true);
    expect(src.canRestore(loc("MAP01", 3), "floorpic")).toBe(true);
    expect(src.canRestore(loc("MAP01", 1), "lightlevel")).toBe(true);
  });
});

describe("unchanged", () => {
  it('"door" 写到 DOOR 上为 false，写到 door 加全零尾部上为 true', () => {
    const src = wadAdapter.open(buildWad({ kind: "PWAD", lumps: map("MAP01", sectors([name("DOOR"), name("door")])) }));
    const a = src.writeField(loc("MAP01", 0), "floorpic", "door");
    const b = src.writeField(loc("MAP01", 1), "floorpic", "door");
    expect(a).toMatchObject({ ok: true, unchanged: false });
    expect(b).toMatchObject({ ok: true, unchanged: true });
  });

  it("整数等价于数值相等", () => {
    const src = wadAdapter.open(buildWad({ kind: "PWAD", lumps: map("MAP01", sectors([name("A")])) }));
    expect(src.writeField(loc("MAP01", 0), "lightlevel", 100)).toMatchObject({ ok: true, unchanged: true });
    expect(src.writeField(loc("MAP01", 0), "lightlevel", 101)).toMatchObject({ ok: true, unchanged: false });
  });
});

describe("写入失败的 reason", () => {
  it("编码错误为 ENCODE", () => {
    const src = wadAdapter.open(buildWad({ kind: "PWAD", lumps: map("MAP01", sectors([name("A")])) }));
    expect(src.writeField(loc("MAP01", 0), "lightlevel", 40000)).toMatchObject({ ok: false, reason: "ENCODE" });
    expect(src.writeField(loc("MAP01", 0), "floorpic", "TOOLONGNAME")).toMatchObject({ ok: false, reason: "ENCODE" });
    expect(src.writeField(loc("MAP01", 0), "lightlevel", "x")).toMatchObject({ ok: false, reason: "ENCODE" });
  });

  it("WadRecordError 用它的 code", () => {
    const clean = buildWad({ kind: "PWAD", lumps: map("MAP01", sectors([name("A")])) });
    const sectorsIndex = WadFile.parse(clean).mapLump(WadFile.parse(clean).maps[0]!, "SECTORS")!.index;
    const src = wadAdapter.open(withFilepos(clean, sectorsIndex, 0));
    expect(src.writeField(loc("MAP01", 0), "floorheight", 1)).toMatchObject({ ok: false, reason: "WRITE_OVERLAPS_STRUCTURE" });
  });

  it("只读记录为 READ_ONLY", () => {
    const src = wadAdapter.open(buildWad({ kind: "PWAD", lumps: map("MAP01", sectors([name("A")])) }));
    expect(src.writeField(loc("MAP01", 0, "Vertex"), "x", 1)).toMatchObject({ ok: false, reason: "READ_ONLY" });
  });

  it("失败的写入不留痕迹", () => {
    const bytes = buildWad({ kind: "PWAD", lumps: map("MAP01", sectors([name("A")])) });
    const src = wadAdapter.open(bytes);
    src.writeField(loc("MAP01", 0), "lightlevel", 40000);
    expect([...src.serialize()]).toEqual([...bytes]);
  });
});

describe("钩子 sector-special-nonzero", () => {
  const bytes = buildWad({ kind: "PWAD", lumps: map("MAP01", sectors([name("A"), name("B")])) }); // special = 0, 1
  const patch = (extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    name: "s",
    target: { format: "wad", maps: "*" },
    operations: [{ id: "strobe", select: { record: "Sector", all: true }, change: { special: { set: 2 } } }],
    ...extra,
  });

  it("special 非零的扇区写 special 为 PROTECTED", () => {
    expect(wadAdapter.hooks.map((h) => [h.name, h.severity])).toEqual([["sector-special-nonzero", "block"]]);
    const r = applyPatch(bytes, patch(), wadAdapter);
    expect(r.ok).toBe(false);
    expect(r.output).toBeUndefined();
    expect(r.issues).toEqual([
      expect.objectContaining({ code: "PROTECTED", hook: "sector-special-nonzero", operationId: "strobe", locator: loc("MAP01", 1), field: "special" }),
    ]);
  });

  it("opt-in 后放行", () => {
    const r = applyPatch(bytes, patch({ allowProtected: ["sector-special-nonzero"] }), wadAdapter);
    expect(r.ok).toBe(true);
    expect(r.receipt!.allowedProtections).toEqual(["sector-special-nonzero"]);
  });

  it("special 为 0 的扇区和其他字段不触发", () => {
    const only = { ...patch(), operations: [{ id: "a", select: { record: "Sector", pin: { map: "MAP01", expectedIndex: 0 } }, change: { special: { set: 2 } } }, { id: "b", select: { record: "Sector", all: true }, change: { lightlevel: { set: 1 } } }] };
    expect(applyPatch(bytes, only, wadAdapter).ok).toBe(true);
  });
});
