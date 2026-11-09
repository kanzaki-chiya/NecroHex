/**
 * 写入护栏（docs/design.md 第 8 节）：结构检查和可玩性检查。
 * 每项拒绝都要带地图、记录下标、字段和原因；检查只针对新写入的值。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyPatch, planPatch, revertPatch, type PatchIssue } from "@necrohex/core";
import { describe, expect, it } from "vitest";
import { buildWad, createWadAdapter, MAP_DATA_LUMPS, wadAdapter, WadFile, type LumpInput } from "../src/index.ts";
import { equalBytes } from "./helpers.ts";
import { FIXTURE, flatsAdapter, flatsIwad } from "./patch-helpers.ts";

interface S { f?: number; c?: number; floor?: string; ceil?: string; light?: number; special?: number; tag?: number }
interface T { type: number; x?: number; flags?: number }
interface L { special?: number; tag?: number; front: number; back?: number }

function name8(v: DataView, at: number, s: string): void {
  for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
}

function mapLumps(marker: string, o: { sectors: S[]; things?: T[]; lines?: L[] }): LumpInput[] {
  const sec = new Uint8Array(26 * o.sectors.length);
  const sv = new DataView(sec.buffer);
  o.sectors.forEach((s, i) => {
    const at = i * 26;
    sv.setInt16(at, s.f ?? 0, true);
    sv.setInt16(at + 2, s.c ?? 128, true);
    name8(sv, at + 4, s.floor ?? "FLAT1");
    name8(sv, at + 12, s.ceil ?? "FLAT1");
    sv.setInt16(at + 20, s.light ?? 160, true);
    sv.setInt16(at + 22, s.special ?? 0, true);
    sv.setInt16(at + 24, s.tag ?? 0, true);
  });
  const things = o.things ?? [];
  const th = new Uint8Array(10 * things.length);
  const tv = new DataView(th.buffer);
  things.forEach((t, i) => {
    tv.setInt16(i * 10, t.x ?? 0, true);
    tv.setInt16(i * 10 + 6, t.type, true);
    tv.setInt16(i * 10 + 8, t.flags ?? 7, true);
  });
  const lines = o.lines ?? [];
  const sides: number[] = [];
  const ln = new Uint8Array(14 * lines.length);
  const lv = new DataView(ln.buffer);
  lines.forEach((l, i) => {
    lv.setUint16(i * 14, 0, true);
    lv.setUint16(i * 14 + 2, 1, true);
    lv.setInt16(i * 14 + 6, l.special ?? 0, true);
    lv.setInt16(i * 14 + 8, l.tag ?? 0, true);
    sides.push(l.front);
    lv.setInt16(i * 14 + 10, sides.length - 1, true);
    if (l.back === undefined) lv.setInt16(i * 14 + 12, -1, true);
    else {
      sides.push(l.back);
      lv.setInt16(i * 14 + 12, sides.length - 1, true);
    }
  });
  const sd = new Uint8Array(30 * sides.length);
  const dv = new DataView(sd.buffer);
  sides.forEach((sector, i) => dv.setInt16(i * 30 + 28, sector, true));
  const data: Record<string, Uint8Array> = { SECTORS: sec, THINGS: th, LINEDEFS: ln, SIDEDEFS: sd, VERTEXES: new Uint8Array(8) };
  return [{ name: marker, data: new Uint8Array(0) }, ...MAP_DATA_LUMPS.map((n) => ({ name: n, data: data[n] ?? Uint8Array.of(0) }))];
}

const wad = (marker: string, o: Parameters<typeof mapLumps>[1], extra: LumpInput[] = []) => buildWad({ kind: "PWAD", lumps: [...mapLumps(marker, o), ...extra] });

const patchOf = (operations: unknown[], extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, name: "guard", target: { format: "wad", maps: "*" }, operations, ...extra });
const op = (record: string, index: number, change: Record<string, unknown>, map = "MAP01") => ({ id: "w", select: { record, pin: { map, expectedIndex: index } }, change });
const setType = (index: number, type: number, map = "MAP01") => op("Thing", index, { type: { set: type } }, map);

function only(issues: PatchIssue[], code: string, hook?: string): PatchIssue[] {
  return issues.filter((i) => i.code === code && (hook === undefined || i.hook === hook));
}

describe("可玩性护栏：受保护的 Thing", () => {
  const things: T[] = [{ type: 1 }, { type: 11 }, { type: 14 }, { type: 5 }, { type: 6 }, { type: 13 }, { type: 38 }, { type: 39 }, { type: 40 }, { type: 3001 }];
  const bytes = wad("MAP01", { sectors: [{}], things });

  it.each([
    [0, "thing-player-start"],
    [1, "thing-player-start"],
    [2, "thing-teleport-destination"],
    ...[3, 4, 5, 6, 7, 8].map((i) => [i, "thing-key"] as const),
  ] as const)("Thing #%i 的任何字段写入为 PROTECTED（%s），带地图、下标、字段和原因", (index, hook) => {
    const r = applyPatch(bytes, patchOf([op("Thing", index, { x: { set: 64 } })]), wadAdapter);
    expect(r.ok).toBe(false);
    expect(r.output).toBeUndefined();
    expect(r.issues).toEqual([expect.objectContaining({ code: "PROTECTED", hook, operationId: "w", locator: { scope: "MAP01", record: "Thing", index }, field: "x" })]);
    expect(r.issues[0]!.message).toMatch(/^MAP01 Thing #\d+ x: Thing type \d+ \(.+\) is a /);
    expect(r.checks.find((c) => c.name === hook)!.status).toBe("failed");
    // 显式 opt-in 后放行
    expect(applyPatch(bytes, patchOf([op("Thing", index, { x: { set: 64 } })], { allowProtected: [hook] }), wadAdapter).ok).toBe(true);
  });

  it("把普通怪物改成玩家出生点或钥匙也被拒绝", () => {
    expect(only(applyPatch(bytes, patchOf([setType(9, 2)]), wadAdapter).issues, "PROTECTED", "thing-player-start")).toHaveLength(1);
    expect(only(applyPatch(bytes, patchOf([setType(9, 40)]), wadAdapter).issues, "PROTECTED", "thing-key")).toHaveLength(1);
    expect(only(applyPatch(bytes, patchOf([setType(9, 14)]), wadAdapter).issues, "PROTECTED", "thing-teleport-destination")).toHaveLength(1);
  });
});

describe("可玩性护栏：地图依赖的 Boss", () => {
  const things: T[] = [{ type: 67 }, { type: 68 }, { type: 72 }, { type: 3003 }];

  it("MAP07 的 Mancubus 和 Arachnotron 不能替换；同样的 Thing 在 MAP01 可以", () => {
    const map07 = wad("MAP07", { sectors: [{}], things });
    for (const index of [0, 1]) {
      const r = applyPatch(map07, patchOf([setType(index, 3001, "MAP07")]), wadAdapter);
      expect(r.issues).toEqual([expect.objectContaining({ code: "PROTECTED", hook: "thing-boss", locator: { scope: "MAP07", record: "Thing", index }, field: "type" })]);
    }
    const map01 = wad("MAP01", { sectors: [{}], things });
    expect(applyPatch(map01, patchOf([setType(0, 3001)]), wadAdapter).issues).toEqual([]);
  });

  it("Commander Keen 在任何地图上都受保护；E1M8 的 Baron 受保护", () => {
    expect(only(applyPatch(wad("MAP01", { sectors: [{}], things }), patchOf([setType(2, 3001)]), wadAdapter).issues, "PROTECTED", "thing-boss")).toHaveLength(1);
    expect(only(applyPatch(wad("E1M8", { sectors: [{}], things }), patchOf([setType(3, 69, "E1M8")]), wadAdapter).issues, "PROTECTED", "thing-boss")).toHaveLength(1);
  });

  it("在 MAP07 新增 Mancubus 也被拒绝（再应用时它会成为受保护的旧值）", () => {
    const r = applyPatch(wad("MAP07", { sectors: [{}], things: [{ type: 3001 }] }), patchOf([setType(0, 67, "MAP07")]), wadAdapter);
    expect(only(r.issues, "PROTECTED", "thing-boss")).toHaveLength(1);
  });
});

describe("可玩性护栏：类别与尺寸", () => {
  const bytes = wad("MAP01", { sectors: [{}], things: [{ type: 3001 }, { type: 3002 }, { type: 9999 }, { type: 2028 }] });

  it("换成不同类别为 PROTECTED（thing-category）", () => {
    const r = applyPatch(bytes, patchOf([setType(0, 2001)]), wadAdapter);
    expect(r.issues).toEqual([expect.objectContaining({ code: "PROTECTED", hook: "thing-category", locator: { scope: "MAP01", record: "Thing", index: 0 }, field: "type" })]);
    expect(r.issues[0]!.message).toContain("is a monster, but 2001 (Shotgun) is a weapon");
    // 立地障碍物和不阻挡的装饰是不同类别
    expect(only(applyPatch(bytes, patchOf([setType(3, 34)]), wadAdapter).issues, "PROTECTED", "thing-category")).toHaveLength(1);
  });

  it("新类型不在类型表里为 VALUE_REJECTED（UNKNOWN_THING_TYPE），不能 opt-in", () => {
    const r = applyPatch(bytes, patchOf([setType(0, 9999)], { allowProtected: ["thing-category"] }), wadAdapter);
    expect(r.issues).toEqual([
      expect.objectContaining({ code: "VALUE_REJECTED", reason: "UNKNOWN_THING_TYPE", locator: { scope: "MAP01", record: "Thing", index: 0 }, field: "type" }),
    ]);
    expect(r.checks.find((c) => c.name === "thing-type-known")!.status).toBe("failed");
  });

  it("旧类型未知时无法判断类别，为 PROTECTED；解析和其他字段的写入不受影响", () => {
    expect(only(applyPatch(bytes, patchOf([setType(2, 3001)]), wadAdapter).issues, "PROTECTED", "thing-category")).toHaveLength(1);
    expect(applyPatch(bytes, patchOf([op("Thing", 2, { x: { set: 32 } })]), wadAdapter).ok).toBe(true);
  });

  it("换成更大的怪物只警告（thing-size-increase）；换成同样大或更小的不警告", () => {
    const bigger = applyPatch(bytes, patchOf([setType(0, 3002)]), wadAdapter);
    expect(bigger.ok).toBe(true);
    expect(bigger.warnings).toEqual([expect.objectContaining({ code: "WARNING", hook: "thing-size-increase", locator: { scope: "MAP01", record: "Thing", index: 0 }, field: "type" })]);
    expect(bigger.warnings[0]!.message).toContain("radius 20 -> 30");
    expect(bigger.checks.find((c) => c.name === "thing-size-increase")!.status).toBe("warned");
    expect(applyPatch(bytes, patchOf([setType(1, 58)]), wadAdapter).warnings).toEqual([]);
    expect(applyPatch(bytes, patchOf([setType(1, 3001)]), wadAdapter).warnings).toEqual([]);
  });
});

describe("结构护栏：贴图名必须存在", () => {
  const flats = [{ name: "F_START", data: new Uint8Array(0) }, { name: "BLOOD1", data: new Uint8Array(4096) }, { name: "F_END", data: new Uint8Array(0) }];
  const set = (pic: string) => patchOf([op("Sector", 0, { floorpic: { set: pic } })]);

  it("当前 WAD 没有这个 Flat、也没有基础 IWAD 时为 VALUE_REJECTED（UNKNOWN_FLAT）", () => {
    const r = applyPatch(wad("MAP01", { sectors: [{}] }), set("BLOOD1"), wadAdapter);
    expect(r.issues).toEqual([
      expect.objectContaining({ code: "VALUE_REJECTED", reason: "UNKNOWN_FLAT", operationId: "w", locator: { scope: "MAP01", record: "Sector", index: 0 }, field: "floorpic" }),
    ]);
    expect(r.issues[0]!.message).toContain("no base IWAD was given");
    expect(r.checks.find((c) => c.name === "flat-exists")!.status).toBe("failed");
  });

  it("当前 WAD 自带的 Flat（F_START 与 F_END 之间）、基础 IWAD 的 Flat 都可以用；名称不分大小写", () => {
    expect(applyPatch(wad("MAP01", { sectors: [{}] }, flats), set("blood1"), wadAdapter).ok).toBe(true);
    expect(applyPatch(wad("MAP01", { sectors: [{}] }), set("BLOOD1"), createWadAdapter({ baseIwad: flatsIwad(["BLOOD1"]) })).ok).toBe(true);
    const r = applyPatch(wad("MAP01", { sectors: [{}] }), set("NUKAGE1"), createWadAdapter({ baseIwad: flatsIwad(["BLOOD1"]) }));
    expect(only(r.issues, "VALUE_REJECTED")[0]!.message).toContain("this WAD or the base IWAD");
  });

  it("写入与当前字节相同的名称不是新值，不检查", () => {
    expect(applyPatch(wad("MAP01", { sectors: [{ floor: "OLDFLAT" }] }), set("OLDFLAT"), wadAdapter).ok).toBe(true);
  });
});

describe("结构护栏：ceilingheight >= floorheight", () => {
  it("写入后天花板低于地板为 VALUE_REJECTED（CEILING_BELOW_FLOOR），拒绝落在写入的字段上", () => {
    const r = applyPatch(wad("MAP01", { sectors: [{ f: 0, c: 128 }] }), patchOf([op("Sector", 0, { floorheight: { set: 200 } })]), wadAdapter);
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([
      expect.objectContaining({ code: "VALUE_REJECTED", reason: "CEILING_BELOW_FLOOR", operationId: "w", locator: { scope: "MAP01", record: "Sector", index: 0 }, field: "floorheight" }),
    ]);
    expect(r.changes).toEqual([]);
    expect(r.checks.find((c) => c.name === "sector-heights")!.status).toBe("failed");
  });

  it("按写入后的值判断：同一补丁同时抬高地板和天花板可以通过", () => {
    const r = applyPatch(
      wad("MAP01", { sectors: [{ f: 0, c: 128 }] }),
      patchOf([{ id: "up", select: { record: "Sector", all: true }, change: { floorheight: { set: 200 }, ceilingheight: { set: 300 } } }]),
      wadAdapter,
    );
    expect(r.issues).toEqual([]);
  });

  it("历史数据里天花板低于地板的扇区可以解析，修改其他字段不被拒绝", () => {
    const bytes = wad("MAP01", { sectors: [{ f: 64, c: 0 }] });
    expect(WadFile.parse(bytes).maps).toHaveLength(1);
    expect(applyPatch(bytes, patchOf([op("Sector", 0, { lightlevel: { set: 32 } })]), wadAdapter).ok).toBe(true);
    // 写入高度字段时检查新状态
    expect(only(applyPatch(bytes, patchOf([op("Sector", 0, { floorheight: { set: 32 } })]), wadAdapter).issues, "VALUE_REJECTED")).toHaveLength(1);
    expect(applyPatch(bytes, patchOf([op("Sector", 0, { ceilingheight: { set: 64 } })]), wadAdapter).ok).toBe(true);
  });
});

describe("可玩性护栏：带 tag 或被线段触发的扇区改高度时警告", () => {
  const bytes = wad("MAP01", {
    sectors: [{ f: 0, c: 128 }, { f: 0, c: 0 }, { f: 0, c: 128, tag: 5 }, { f: 0, c: 128 }],
    // 线段 0：手动门（special 1，tag 0），背面是扇区 1；线段 1：tag 5 的开关
    lines: [{ special: 1, front: 0, back: 1 }, { special: 103, tag: 5, front: 0 }],
  });
  const raise = (index: number) => applyPatch(bytes, patchOf([op("Sector", index, { ceilingheight: { set: 136 } })]), wadAdapter);

  it("手动门的背面扇区、带 tag 的扇区：警告，不拒绝", () => {
    for (const index of [1, 2]) {
      const r = raise(index);
      expect(r.ok).toBe(true);
      expect(r.warnings).toEqual([expect.objectContaining({ code: "WARNING", hook: "sector-height-linked", locator: { scope: "MAP01", record: "Sector", index }, field: "ceilingheight" })]);
    }
  });

  it("其他扇区不警告；只改亮度不警告", () => {
    expect(raise(0).warnings).toEqual([]);
    expect(raise(3).warnings).toEqual([]);
    expect(applyPatch(bytes, patchOf([op("Sector", 2, { lightlevel: { set: 32 } })]), wadAdapter).warnings).toEqual([]);
  });
});

describe("检查报告", () => {
  it("列出每项检查和结果，不声称可玩", () => {
    const r = planPatch(wad("MAP01", { sectors: [{}] }), patchOf([op("Sector", 0, { lightlevel: { set: 64 } })]), wadAdapter);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => [c.name, c.kind, c.status])).toEqual([
      ["field-conflict", "engine", "passed"],
      ["old-value-restorable", "engine", "passed"],
      ["field-value", "structure", "passed"],
      ["write-target", "structure", "passed"],
      ["flat-exists", "structure", "passed"],
      ["thing-type-known", "structure", "passed"],
      ["sector-heights", "structure", "passed"],
      ...wadAdapter.hooks.map((h) => [h.name, "playability", "passed"]),
    ]);
    for (const c of r.checks) expect(c.description).not.toMatch(/playable|guarantee/i);
  });

  it("显式放行的拦截为 allowed；有条目在检查前被排除时结构检查为 incomplete", () => {
    const bytes = wad("MAP01", { sectors: [{}], things: [{ type: 1 }] });
    const allowed = planPatch(bytes, patchOf([op("Thing", 0, { x: { set: 8 } })], { allowProtected: ["thing-player-start"] }), wadAdapter);
    expect(allowed.checks.find((c) => c.name === "thing-player-start")!.status).toBe("allowed");
    const conflict = planPatch(
      bytes,
      patchOf([op("Sector", 0, { tag: { set: 1 } }), { ...op("Sector", 0, { tag: { set: 2 } }), id: "w2" }]),
      wadAdapter,
    );
    expect(conflict.checks.find((c) => c.name === "field-conflict")!.status).toBe("failed");
    expect(conflict.checks.find((c) => c.name === "sector-heights")!.status).toBe("incomplete");
  });
});

describe("Freedoom 夹具", () => {
  it("MAP01 的玩家 1 出生点受保护", () => {
    const src = wadAdapter.open(FIXTURE);
    let index = -1;
    for (let i = 0; i < src.recordCount("MAP01", "Thing"); i++) {
      if (src.readField({ scope: "MAP01", record: "Thing", index: i }, "type") === 1) index = i;
    }
    expect(index).toBeGreaterThanOrEqual(0);
    const r = applyPatch(FIXTURE, patchOf([op("Thing", index, { angle: { set: 0 } })]), wadAdapter);
    expect(r.issues).toEqual([expect.objectContaining({ code: "PROTECTED", hook: "thing-player-start", locator: { scope: "MAP01", record: "Thing", index }, field: "angle" })]);
  });

  it("patches/haunted-house.nhpatch.json：基础 IWAD 提供 BLOOD1 时通过全部检查、没有警告，撤销后逐字节还原", () => {
    const patch = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../patches/haunted-house.nhpatch.json"), "utf8")) as unknown;
    // 夹具只含地图，不带 Flat
    expect(only(applyPatch(FIXTURE, patch, wadAdapter).issues, "VALUE_REJECTED").every((i) => i.reason === "UNKNOWN_FLAT")).toBe(true);
    const r = applyPatch(FIXTURE, patch, flatsAdapter);
    expect(r.issues).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.checks.every((c) => c.status === "passed")).toBe(true);
    for (const scope of ["MAP01", "MAP02"]) {
      // 玩家出生点所在的 #0 扇区改为慢速频闪
      expect(r.changes).toContainEqual(expect.objectContaining({ scope, record: "Sector", index: 0, field: "special", newValue: 3 }));
    }
    const back = revertPatch(r.output!, JSON.parse(JSON.stringify(r.receipt)), flatsAdapter);
    expect(back.issues).toEqual([]);
    expect(equalBytes(back.output!, FIXTURE)).toBe(true);
  });
});
