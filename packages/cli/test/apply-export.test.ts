/**
 * apply 导出的 PWAD 按真正改动的范围标记 maps[].modified（回归：曾用重新解析的输出导出，没有脏区间，modified 一直是 false）。
 * 在进程内调用 ops.ts，用 Freedoom MAP01–MAP02 夹具。
 */
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyPatch } from "@necrohex/core";
import { exportPwad, wadAdapter, WadFile } from "@necrohex/adapter-wad";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apply, replayChanges } from "../src/ops.ts";
import { openWorkspace, type Workspace } from "../src/workspace.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const FIXTURE = join(REPO, "packages/adapter-wad/fixtures/freedoom/freedoom2-map01-02.wad");

const PATCH = {
  schemaVersion: 1,
  name: "dim MAP01",
  target: { format: "wad", maps: ["MAP01"] },
  operations: [{ id: "light", select: { record: "Sector", where: { lightlevel: { gte: 192 } } }, change: { lightlevel: { set: 100 } } }],
};

let dir: string;
let ws: Workspace;
beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "necrohex-apply-export-")));
  copyFileSync(FIXTURE, join(dir, "map.wad"));
  writeFileSync(join(dir, "p.json"), JSON.stringify(PATCH));
  ws = openWorkspace({ root: dir });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("apply 的 maps[].modified", () => {
  it("改 MAP01 后导出的 PWAD 里 MAP01 的 modified 为 true，没改动的 MAP02 不导出", () => {
    const r = apply(ws, { inputPath: "map.wad", patchPath: "p.json", outputPath: "out.wad" });
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.maps.map((m) => [m.name, m.modified])).toEqual([["MAP01", true]]);
    expect(WadFile.parse(new Uint8Array(readFileSync(join(dir, "out.wad")))).maps.map((m) => m.name)).toEqual(["MAP01"]);
  });

  it("重放得到的 WadFile 带脏区间：同时导出 MAP01 和 MAP02 时，MAP01 为 true，MAP02 为 false", () => {
    const input = new Uint8Array(readFileSync(FIXTURE));
    const r = applyPatch(input, PATCH, wadAdapter);
    expect(r.ok).toBe(true);
    const wad = replayChanges(input, r.changes, r.output!);
    expect(wad.serialize()).toEqual(r.output);
    expect(exportPwad(wad, { maps: ["MAP01", "MAP02"] }).maps.map((m) => [m.name, m.modified])).toEqual([
      ["MAP01", true],
      ["MAP02", false],
    ]);
    // 旧做法：重新解析输出，没有脏区间，两张地图都是 false
    expect(exportPwad(WadFile.parse(r.output!), { maps: ["MAP01", "MAP02"] }).maps.map((m) => m.modified)).toEqual([false, false]);
  });
});
