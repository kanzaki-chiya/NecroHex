/**
 * Session 用 Freedoom MAP01–MAP02 夹具（PWAD，不带 Flat）：基础 IWAD 用只含几个 Flat 的小 IWAD，代替完整的 freedoom2.wad。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyPatch, bytesHash } from "@necrohex/core";
import { buildWad, createWadAdapter, exportPatchPwad, WadFile } from "@necrohex/adapter-wad";
import { describe, expect, it } from "vitest";
import { CARELESS_EDIT } from "../src/state/presets.ts";
import { Session, SessionError } from "../src/worker/session.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const FIXTURE = new Uint8Array(readFileSync(resolve(REPO, "packages/adapter-wad/fixtures/freedoom/freedoom2-map01-02.wad")));
const HAUNTED = JSON.parse(readFileSync(resolve(REPO, "patches/haunted-house.nhpatch.json"), "utf8")) as unknown;
const RELOCATION = JSON.parse(readFileSync(resolve(REPO, "patches/relocation-demo.nhpatch.json"), "utf8")) as unknown;

/** 带 BLOOD1 的小 IWAD，作为“内置样本”传给 Session。 */
const BASE = buildWad({
  kind: "IWAD",
  lumps: [
    { name: "F_START", data: new Uint8Array(0) },
    { name: "BLOOD1", data: new Uint8Array(4096) },
    { name: "F_END", data: new Uint8Array(0) },
  ],
});
const BASE_SAMPLE = { sha256: bytesHash(BASE).slice("sha256:".length), version: "test base" };

function opened(): Session {
  const s = new Session();
  s.open("base.wad", BASE, BASE_SAMPLE);
  s.open("map01-02.wad", FIXTURE);
  return s;
}

describe("Session.open", () => {
  it("样本哈希不符时拒绝，之前打开的文件不变", () => {
    const s = opened();
    expect(() => s.open("x.wad", BASE, { sha256: "0".repeat(64), version: "x" })).toThrow(SessionError);
    expect(s.summary?.name).toBe("map01-02.wad");
  });

  it("不是 WAD 时为 INVALID_WAD，之前打开的文件不变", () => {
    const s = opened();
    expect(() => s.open("bad.wad", new Uint8Array([1, 2, 3]))).toThrow(expect.objectContaining({ code: "INVALID_WAD" }));
    expect(s.summary?.name).toBe("map01-02.wad");
  });

  it("PWAD 用样本作为基础 IWAD；地图列表带作用域", () => {
    const s = opened();
    expect(s.summary).toMatchObject({ kind: "PWAD", baseIwad: "base.wad", sha256: bytesHash(FIXTURE), version: null });
    expect(s.summary!.maps).toEqual([
      { scope: "MAP01", name: "MAP01", format: "doom" },
      { scope: "MAP02", name: "MAP02", format: "doom" },
    ]);
  });
});

describe("Session.mapData", () => {
  it("MAP01：扇区路径、线段、Thing、Lump 偏移和指纹", () => {
    const m = opened().mapData("MAP01");
    const wad = WadFile.parse(FIXTURE);
    const map = wad.findMap("MAP01")!;
    const sectors = wad.lumps[map.lumps["SECTORS"]!]!;
    expect(m.sectors.length).toBe(sectors.size / 26);
    expect(m.sectors.every((s) => /^M-?\d/.test(s.d) && s.d.endsWith("Z"))).toBe(true);
    expect(m.things.length).toBe(wad.recordCount(map.lumps["THINGS"]!, "Thing"));
    expect(m.lumps.SECTORS).toMatchObject({ offset: sectors.filepos });
    expect(m.lumps.SECTORS!.bytes).toEqual(wad.lumpBytes(map.lumps["SECTORS"]!));
    expect(m.fingerprints[0]).toMatchObject({ floorpic: "SLIME14", bbox: [-224, -288, -32, 32], area: 53504, lineCount: 16 });
    expect(m.flats).toContain("BLOOD1");
  });
});

describe("Session.plan", () => {
  it("haunted-house：可以写入，有 sector-light-effect-invisible 警告；after 字节等于引擎输出的 SECTORS", () => {
    const s = opened();
    const p = s.plan(1, HAUNTED, "MAP01");
    expect(p.ok).toBe(true);
    expect(p.warnings.map((w) => w.hook)).toContain("sector-light-effect-invisible");
    expect(p.changes.length).toBe(p.changedByScope["MAP01"]);
    expect(Object.keys(p.changedByScope).sort()).toEqual(["MAP01", "MAP02"]);
    expect(p.pins).toEqual([expect.objectContaining({ op: "strobe-start-map01", result: "EXACT", index: 0, scope: "MAP01" })]);
    const r = applyPatch(FIXTURE, HAUNTED, createWadAdapter({ baseIwad: BASE }));
    const out = WadFile.parse(r.output!);
    expect(p.after!.SECTORS).toEqual(out.lumpBytes(out.findMap("MAP01")!.lumps["SECTORS"]!));
    expect(p.after!.THINGS).toEqual(out.lumpBytes(out.findMap("MAP01")!.lumps["THINGS"]!));
  });

  it("careless-edit：被拒绝，问题带定位和操作 id，没有 after", () => {
    const p = opened().plan(2, CARELESS_EDIT, "MAP01");
    expect(p.ok).toBe(false);
    expect(p.after).toBeNull();
    expect(p.issues.some((i) => i.code === "PROTECTED" && i.hook === "thing-player-start" && i.op === "starts-to-imps" && i.locator?.record === "Thing")).toBe(true);
    expect(p.issues.some((i) => i.code === "VALUE_REJECTED" && i.reason === "ENCODE" && i.op === "long-flat-name")).toBe(true);
  });

  it("relocation-demo 在夹具上：pin 的结果来自引擎（夹具就是 0.13.0 的 MAP01，#74 重定位到 #196）", () => {
    const p = opened().plan(3, RELOCATION, "MAP01");
    expect(p.pins[0]).toMatchObject({ result: "RELOCATED", expectedIndex: 74, index: 196 });
    expect(p.changes).toEqual([expect.objectContaining({ index: 196, field: "floorpic", kind: "RELOCATED", newValue: "BLOOD1" })]);
  });

  it("不合法的补丁：INVALID_PATCH，patchHash 为 null", () => {
    const p = opened().plan(4, { schemaVersion: 1, name: "x", target: { format: "wad", maps: ["MAP01"] }, operations: [] }, "MAP01");
    expect(p.ok).toBe(false);
    expect(p.patchHash).toBeNull();
    expect(p.issues[0]).toMatchObject({ code: "INVALID_PATCH", path: "/operations" });
  });
});

describe("Session.export", () => {
  it("与 exportPatchPwad 的结果逐字节相同，回执与 CLI 同格式；源字节不变", () => {
    const s = opened();
    const e = s.export(HAUNTED);
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    const r = applyPatch(FIXTURE, HAUNTED, createWadAdapter({ baseIwad: BASE }));
    expect(e.pwad).toEqual(exportPatchPwad(FIXTURE, r).bytes);
    expect(e.receiptJson).toBe(JSON.stringify(r.receipt, null, 2) + "\n");
    expect(e.maps.map((m) => [m.name, m.modified])).toEqual([
      ["MAP01", true],
      ["MAP02", true],
    ]);
    expect(e.receipt.inputHash).toBe(bytesHash(FIXTURE));
    // 导出之后规划仍以源文件为输入
    expect(s.plan(5, HAUNTED, "MAP01").changes.length).toBeGreaterThan(0);
  });

  it("被拒绝的补丁和没有改动的补丁都不导出", () => {
    const s = opened();
    expect(s.export(CARELESS_EDIT)).toMatchObject({ ok: false, code: "PATCH_REJECTED" });
    const noop = { schemaVersion: 1, name: "noop", target: { format: "wad", maps: ["MAP01"] }, operations: [{ id: "c", select: { record: "Sector", all: true }, change: { lightlevel: { clamp: [0, 255] } } }] };
    expect(s.export(noop)).toMatchObject({ ok: false, code: "NOTHING_TO_EXPORT" });
  });

  it("receipt 只返回哈希", () => {
    const r = opened().receipt(7, HAUNTED);
    expect(r).toMatchObject({ seq: 7, ok: true, inputHash: bytesHash(FIXTURE) });
    expect(r.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
