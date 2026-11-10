/**
 * exportPatchPwad：CLI 的 apply 和工作台共用的导出流程。用 Freedoom MAP01–MAP02 夹具。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyPatch } from "@necrohex/core";
import { describe, expect, it } from "vitest";
import { exportPatchPwad, replayChanges, scopeMap, wadAdapter, WadExportError, WadFile } from "../src/index.ts";
import { flatsAdapter } from "./patch-helpers.ts";

const FIXTURE = new Uint8Array(readFileSync(resolve(import.meta.dirname, "../fixtures/freedoom/freedoom2-map01-02.wad")));
const HAUNTED = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../patches/haunted-house.nhpatch.json"), "utf8")) as unknown;

const patch = (maps: string[], change: Record<string, unknown>, where: Record<string, unknown> = { lightlevel: { gte: 192 } }) => ({
  schemaVersion: 1,
  name: "t",
  target: { format: "wad", maps },
  operations: [{ id: "op", select: { record: "Sector", where }, change }],
});

describe("exportPatchPwad", () => {
  it("haunted-house 改了 MAP01 和 MAP02：两张都导出，modified 为 true，数据等于引擎输出里的对应 Lump", () => {
    const r = applyPatch(FIXTURE, HAUNTED, flatsAdapter);
    expect(r.ok).toBe(true);
    const before = FIXTURE.slice();
    const pwad = exportPatchPwad(FIXTURE, r);
    expect(FIXTURE).toEqual(before);
    expect(pwad.maps.map((m) => [m.name, m.modified, m.lumps.length])).toEqual([
      ["MAP01", true, 11],
      ["MAP02", true, 11],
    ]);
    const out = WadFile.parse(pwad.bytes);
    const full = WadFile.parse(r.output!);
    for (const name of ["MAP01", "MAP02"]) {
      const a = out.findMap(name)!;
      const b = full.findMap(name)!;
      a.dataIndices.forEach((i, k) => expect(out.lumpBytes(i)).toEqual(full.lumpBytes(b.dataIndices[k]!)));
    }
  });

  it("只改 MAP01 时只导出 MAP01", () => {
    const r = applyPatch(FIXTURE, patch(["MAP01", "MAP02"], { lightlevel: { set: 100 } }, { lightlevel: { gte: 255 } }), wadAdapter);
    expect(r.ok).toBe(true);
    const scopes = new Set(r.changes.filter((c) => !c.unchanged).map((c) => c.scope));
    const pwad = exportPatchPwad(FIXTURE, r);
    expect(pwad.maps.map((m) => m.name)).toEqual([...scopes].sort());
  });

  it("没有任何字节改变时拒绝（NOTHING_TO_EXPORT）", () => {
    const r = applyPatch(FIXTURE, patch(["MAP01"], { lightlevel: { clamp: [0, 255] } }), wadAdapter);
    expect(r.ok).toBe(true);
    expect(r.changedCount).toBe(0);
    expect(() => exportPatchPwad(FIXTURE, r)).toThrow(expect.objectContaining({ code: "NOTHING_TO_EXPORT" }));
  });

  it("被拒绝的结果不能导出", () => {
    const r = applyPatch(FIXTURE, patch(["MAP01"], { floorpic: { set: "NOSUCHFL" } }, { floorheight: { gte: -32768 } }), wadAdapter);
    expect(r.ok).toBe(false);
    expect(() => exportPatchPwad(FIXTURE, r)).toThrow(TypeError);
  });
});

describe("replayChanges", () => {
  it("结果带脏区间，与引擎输出逐字节相同；expected 不同时抛 REPLAY_MISMATCH", () => {
    const r = applyPatch(FIXTURE, HAUNTED, flatsAdapter);
    const wad = replayChanges(FIXTURE, r.changes, r.output!);
    expect(wad.dirtySpans().length).toBeGreaterThan(0);
    expect(wad.serialize()).toEqual(r.output);
    const wrong = r.output!.slice();
    wrong[0] = wrong[0]! ^ 1;
    expect(() => replayChanges(FIXTURE, r.changes, wrong)).toThrow(WadExportError);
    expect(() => replayChanges(FIXTURE, r.changes, wrong)).toThrow(expect.objectContaining({ code: "REPLAY_MISMATCH" }));
  });

  it("scopeMap 认 MAP01 和 MAP01@<markerIndex>", () => {
    const wad = WadFile.parse(FIXTURE);
    const m = wad.findMap("MAP01")!;
    expect(scopeMap(wad, "MAP01")).toBe(m);
    expect(scopeMap(wad, `MAP01@${m.markerIndex}`)).toBe(m);
    expect(scopeMap(wad, `MAP01@${m.markerIndex + 1}`)).toBeUndefined();
    expect(scopeMap(wad, "MAP09")).toBeUndefined();
  });
});
