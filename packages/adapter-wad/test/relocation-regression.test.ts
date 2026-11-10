/**
 * 跨版本重定位选错的回归用例（Freedoom 0.12.1 ↔ 0.13.0，docs/decisions.md 2026-11-09“指纹加入边界框和面积”）。
 * 旧指纹只有几何中心，分不清中心相同、大小不同的扇区，下面的源扇区都曾被定位到面积覆盖率为 0 的目标。
 *
 * 两组断言：
 * 1. 不依赖缓存：源扇区和错误目标的指纹直接写在这里（只是从两个发行版算出的数，不含地图数据），
 *    新相似度必须低于高置信度下限，所以无论地图里还有什么扇区，都不可能再选中这个目标；同时核对旧公式确实达到了下限。
 * 2. 有 fixtures/cache/freedoom-<版本>/freedoom2.wad 时：在真实地图上用补丁引擎解析，结果不是错误目标。缺文件时跳过，REQUIRE_FREEDOOM=1 时失败。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { planPatch, RELOCATION_THRESHOLDS } from "@necrohex/core";
import { describe, expect, it } from "vitest";
import { createWadAdapter, FINGERPRINT_PARAMS, sectorFingerprintScore, wadAdapter, type FingerprintParams, type SectorFingerprint } from "../src/index.ts";
import { haveFreedoom } from "./helpers.ts";

/** 修复前的公式：没有 bbox 和面积，几何中心 0.4，半径 32。 */
const OLD: FingerprintParams = {
  ...FINGERPRINT_PARAMS,
  weights: { centroid: 0.4, bbox: 0, area: 0, lineCount: 0.1, heights: 0.2, floorpic: 0.1, ceilingpic: 0.1, tag: 0.1 },
};
const round = (s: number) => Math.round(s * 10000) / 10000;

interface Case {
  readonly name: string;
  readonly from: "0.12.1" | "0.13.0";
  readonly to: "0.12.1" | "0.13.0";
  readonly map: string;
  readonly index: number;
  readonly wrong: number;
  /** 旧公式下的结果 */
  readonly was: "EXACT" | "RELOCATED";
  readonly source: SectorFingerprint;
  readonly target: SectorFingerprint;
}

const CASES: readonly Case[] = [
  {
    name: "MAP12 #908（FLOOR4_5）不再定位到 #752（AQF069）",
    from: "0.12.1",
    to: "0.13.0",
    map: "MAP12",
    index: 908,
    wrong: 752,
    was: "RELOCATED",
    source: { tag: 0, floorpic: "FLOOR4_5", ceilingpic: "F_SKY1", heights: [-64, 256], centroid: [96, 1040], bbox: [32, 928, 160, 1152], area: 14336, lineCount: 16 },
    target: { tag: 0, floorpic: "AQF069", ceilingpic: "F_SKY1", heights: [-64, 256], centroid: [96, 1040], bbox: [32, 888, 160, 1192], area: 2048, lineCount: 8 },
  },
  {
    name: "MAP12 #919（SLIME16）不再定位到 #752（AQF069）",
    from: "0.12.1",
    to: "0.13.0",
    map: "MAP12",
    index: 919,
    wrong: 752,
    was: "RELOCATED",
    source: { tag: 0, floorpic: "SLIME16", ceilingpic: "F_SKY1", heights: [-64, 256], centroid: [96, 1040], bbox: [64, 928, 128, 1152], area: 14336, lineCount: 4 },
    target: { tag: 0, floorpic: "AQF069", ceilingpic: "F_SKY1", heights: [-64, 256], centroid: [96, 1040], bbox: [32, 888, 160, 1192], area: 2048, lineCount: 8 },
  },
  {
    name: "MAP05 #107 不再定位到 #66（中心相同，高 32 对高 88）",
    from: "0.12.1",
    to: "0.13.0",
    map: "MAP05",
    index: 107,
    wrong: 66,
    was: "RELOCATED",
    source: { tag: 0, floorpic: "FWATER4", ceilingpic: "CEIL5_2", heights: [-128, 0], centroid: [2256, 48], bbox: [2192, 32, 2320, 64], area: 2048, lineCount: 6 },
    target: { tag: 0, floorpic: "FWATER4", ceilingpic: "CEIL5_2", heights: [-128, 0], centroid: [2256, 50], bbox: [2192, 8, 2320, 96], area: 9216, lineCount: 10 },
  },
  {
    name: "MAP12 #1072 不再定位到 #152（中心相同，高 160 对高 112）",
    from: "0.12.1",
    to: "0.13.0",
    map: "MAP12",
    index: 1072,
    wrong: 152,
    was: "RELOCATED",
    source: { tag: 0, floorpic: "FLOOR6_2", ceilingpic: "CEIL3_5", heights: [-92, 112], centroid: [-904, -1344], bbox: [-936, -1424, -872, -1264], area: 2048, lineCount: 8 },
    target: { tag: 0, floorpic: "FLOOR6_2", ceilingpic: "CEIL3_5", heights: [-92, 112], centroid: [-904, -1344], bbox: [-936, -1400, -872, -1288], area: 7168, lineCount: 4 },
  },
  {
    name: "EXACT 也要核对：MAP01 #17 在 0.13.0 上的同一下标是一条 1 单位高的细条，不能判为 EXACT",
    from: "0.12.1",
    to: "0.13.0",
    map: "MAP01",
    index: 17,
    wrong: 17,
    was: "EXACT",
    source: { tag: 0, floorpic: "AQF026", ceilingpic: "FLAT23", heights: [0, 0], centroid: [119, 5], bbox: [-32, 0, 256, 32], area: 4608, lineCount: 7 },
    target: { tag: 0, floorpic: "AQF026", ceilingpic: "FLAT23", heights: [0, 0], centroid: [126, 0], bbox: [-32, 0, 256, 1], area: 144, lineCount: 10 },
  },
  {
    name: "EXACT 也要核对：MAP25 #375（64×64）在 0.12.1 上的同一下标是 8×8 的另一个扇区，不能判为 EXACT",
    from: "0.13.0",
    to: "0.12.1",
    map: "MAP25",
    index: 375,
    wrong: 375,
    was: "EXACT",
    source: { tag: 42, floorpic: "SLIME13", ceilingpic: "SLIME13", heights: [0, 128], centroid: [-803, 742], bbox: [-832, 704, -768, 768], area: 4096, lineCount: 5 },
    target: { tag: 42, floorpic: "SLIME13", ceilingpic: "SLIME13", heights: [0, 128], centroid: [-804, 732], bbox: [-808, 728, -800, 736], area: 64, lineCount: 4 },
  },
];

describe("重定位回归：指纹对（不依赖缓存）", () => {
  it.each(CASES)("$name", (c) => {
    expect(round(sectorFingerprintScore(c.source, c.target, OLD))).toBeGreaterThanOrEqual(RELOCATION_THRESHOLDS.high);
    expect(round(sectorFingerprintScore(c.source, c.target))).toBeLessThan(RELOCATION_THRESHOLDS.high);
  });
});

const cachePath = (v: string) => resolve(import.meta.dirname, `../fixtures/cache/freedoom-${v}/freedoom2.wad`);
const haveCache = haveFreedoom(cachePath("0.12.1"), cachePath("0.13.0"));
const load = (() => {
  const loaded = new Map<string, Uint8Array>();
  return (v: string) => {
    let b = loaded.get(v);
    if (!b) loaded.set(v, (b = new Uint8Array(readFileSync(cachePath(v)))));
    return b;
  };
})();

function resolvePin(from: string, to: string, map: string, index: number) {
  const fingerprint = wadAdapter.open(load(from)).fingerprints!.compute({ scope: map, record: "Sector", index });
  const patch = { schemaVersion: 1, name: "regression", target: { format: "wad", maps: [map] }, operations: [{ id: "p", select: { record: "Sector", pin: { map, expectedIndex: index, fingerprint } }, change: { lightlevel: { scale: 1 } } }] };
  return { fingerprint, pin: planPatch(load(to), patch, wadAdapter).pins[0]! };
}

describe.skipIf(!haveCache)("重定位回归：真实地图（需要 fixtures/cache 下的 0.12.1 和 0.13.0）", () => {
  it.each(CASES)("$name", (c) => {
    const { fingerprint, pin } = resolvePin(c.from, c.to, c.map, c.index);
    // 写在上面的指纹就是从真实地图算出来的
    expect(fingerprint).toEqual(c.source);
    expect(wadAdapter.open(load(c.to)).fingerprints!.compute({ scope: c.map, record: "Sector", index: c.wrong })).toEqual(c.target);
    expect(pin.index).not.toBe(c.wrong);
    // 这几个源扇区在目标版本里没有可信的对应扇区，现在都拒绝
    expect(["CONFLICT_AMBIGUOUS", "CONFLICT_MISSING"]).toContain(pin.result);
  });

  // 校准过程中只加 bbox、不加面积的候选公式把它选到了 #52（面积覆盖率 0）；#52 在 0.13.0 里仍然存在，#106 是从别的扇区新划出的
  it("MAP01 #106（0.13.0）不定位到 #52（0.12.1）", () => {
    const { pin } = resolvePin("0.13.0", "0.12.1", "MAP01", 106);
    expect(pin.index).not.toBe(52);
    expect(pin.result).toBe("CONFLICT_AMBIGUOUS");
    expect(resolvePin("0.13.0", "0.12.1", "MAP01", 52).pin).toMatchObject({ result: "EXACT", index: 52 });
  });

  it("对照：MAP01 #19（0.12.1）仍重定位到 #42（0.13.0），两边边界线段坐标完全相同", () => {
    expect(resolvePin("0.12.1", "0.13.0", "MAP01", 19).pin).toMatchObject({ result: "RELOCATED", index: 42, score: 1 });
  });

  // patches/relocation-demo.nhpatch.json 的 pin。#196 没有对照一（边界线段有改动），面积覆盖 0.94
  it("演示 pin：MAP01 #74（0.12.1）在 0.13.0 上是 RELOCATED #196，不是同下标的 #74（另一条窄条）", () => {
    const { pin } = resolvePin("0.12.1", "0.13.0", "MAP01", 74);
    expect(pin).toMatchObject({ result: "RELOCATED", expectedIndex: 74, index: 196, score: 0.8728 });
    const same = wadAdapter.open(load("0.13.0")).fingerprints!.compute({ scope: "MAP01", record: "Sector", index: 74 }) as SectorFingerprint;
    expect(same.bbox).toEqual([1852, -760, 1872, -640]);
    expect(pin.candidates.some((c) => c.index === 74 && c.score >= RELOCATION_THRESHOLDS.high)).toBe(false);
  });

  it("演示补丁文件在 0.13.0 上应用：回执为 #74 → #196，floorpic SLIME14 → BLOOD1", () => {
    const patch = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../patches/relocation-demo.nhpatch.json"), "utf8")) as unknown;
    const r = planPatch(load("0.13.0"), patch, createWadAdapter({ baseIwad: load("0.13.0") }));
    expect(r.issues).toEqual([]);
    expect(r.changes).toEqual([
      expect.objectContaining({
        scope: "MAP01",
        index: 196,
        field: "floorpic",
        oldValue: "SLIME14",
        newValue: "BLOOD1",
        selection: { kind: "RELOCATED", expectedIndex: 74, fingerprintChecked: true, score: 0.8728 },
      }),
    ]);
  });
});
