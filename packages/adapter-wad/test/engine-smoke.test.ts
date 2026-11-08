/**
 * 引擎冒烟测试。需要本地的 DSDA-Doom 和完整的 freedoom2.wad：
 * NECROHEX_ENGINE 指向 dsda-doom 可执行文件，freedoom2.wad 放在 fixtures/cache/。缺任何一个时跳过。
 * 引擎是 GPL 程序，不进入仓库，只作为独立进程调用。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildIdleDemo, buildWad, exportPwad, WadFile } from "../src/index.ts";
import { runEngineSmoke } from "../src/node/engine-smoke.ts";

describe("演示录像", () => {
  it("v1.9 头、每 tic 4 字节零输入、结束标记", () => {
    const d = buildIdleDemo({ map: "MAP07", tics: 3 });
    expect([...d]).toEqual([109, 2, 1, 7, 0, 0, 0, 0, 0, 1, 0, 0, 0, ...new Array(12).fill(0), 0x80]);
    expect([...buildIdleDemo({ map: "e2m4", tics: 1, skill: 4 }).subarray(0, 4)]).toEqual([109, 4, 2, 4]);
  });

  it("拒绝无法写进录像头的参数", () => {
    expect(() => buildIdleDemo({ map: "MAP00", tics: 1 })).toThrow(RangeError);
    expect(() => buildIdleDemo({ map: "START", tics: 1 })).toThrow(RangeError);
    expect(() => buildIdleDemo({ map: "MAP01", tics: 0 })).toThrow(RangeError);
    expect(() => buildIdleDemo({ map: "MAP01", tics: 1, skill: 5 })).toThrow(RangeError);
  });
});

const engine = process.env["NECROHEX_ENGINE"];
const iwad = resolve(import.meta.dirname, "../fixtures/cache/freedoom2.wad");
const ready = !!engine && existsSync(engine) && existsSync(iwad);

describe.skipIf(!ready)("引擎冒烟（DSDA-Doom）", () => {
  const dir = mkdtempSync(join(tmpdir(), "necrohex-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function mapLumpsOnlyChanged(wad: WadFile): Uint8Array {
    const m = wad.findMap("MAP01")!;
    return buildWad({ kind: "PWAD", lumps: [{ name: "MAP01", data: new Uint8Array(0) }, { name: "SECTORS", data: wad.lumpBytes(m.lumps["SECTORS"]!) }] });
  }

  it("调暗 MAP01 后导出的 PWAD：引擎载入它，在 MAP01 上跑完 350 tic 并正常退出", async () => {
    const wad = WadFile.parse(new Uint8Array(readFileSync(iwad)));
    const sectors = wad.findMap("MAP01")!.lumps["SECTORS"]!;
    wad.readRecords(sectors, "Sector").forEach((s, i) => {
      if (s.lightlevel >= 160) wad.setField(sectors, "Sector", i, "lightlevel", s.lightlevel >> 1);
    });
    const pwad = join(dir, "map01-dimmed.wad");
    writeFileSync(pwad, exportPwad(wad).bytes);
    const r = await runEngineSmoke({ engine: engine!, iwad, pwad, map: "MAP01", tics: 350 });
    expect(r.failure, r.output).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.gametics).toBe(350);
  }, 90_000);

  it("对照：只含标记和改动 Lump 的 PWAD 让引擎失败，冒烟测试能发现它", async () => {
    const wad = WadFile.parse(new Uint8Array(readFileSync(iwad)));
    const pwad = join(dir, "map01-sectors-only.wad");
    writeFileSync(pwad, mapLumpsOnlyChanged(wad));
    const r = await runEngineSmoke({ engine: engine!, iwad, pwad, map: "MAP01", tics: 35 });
    expect(r.ok).toBe(false);
    expect(r.gametics).toBeNull();
    expect(r.output).toMatch(/LINEDEFS/);
  }, 90_000);
});
