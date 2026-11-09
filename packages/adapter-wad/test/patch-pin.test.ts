import { patchHash, planPatch, RELOCATION_THRESHOLDS } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sectorFingerprintScore, validateSectorFingerprint, wadAdapter, type SectorFingerprint } from "../src/index.ts";
import { dupMapWad, profile } from "./arbitraries.ts";
import { BLOCK_HOOKS, Hits, RUNS, SAMPLES } from "./patch-helpers.ts";

type Rec = "Sector" | "Thing";
// 标记写入：lightlevel 不涉及 ceilingheight >= floorheight；Thing 的写入可能落在受保护的类型上，所以补丁放行全部拦截钩子
const MARK: Record<Rec, string> = { Sector: "lightlevel", Thing: "x" };

const json: fc.Arbitrary<unknown> = fc.jsonValue({ maxDepth: 2 });

/** 键排序后的 JSON，独立于 core 的 canonicalJson。undefined 表示没有 fingerprint。 */
function canon(v: unknown): string | undefined {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x;
  return v === undefined ? undefined : JSON.stringify(sort(v));
}

function pinPatch(record: Rec, map: string, expectedIndex: number, fingerprint?: unknown) {
  return {
    schemaVersion: 1,
    name: "pin",
    target: { format: "wad", maps: "*" },
    allowProtected: BLOCK_HOOKS,
    operations: [
      { id: "p", select: { record, pin: { map, expectedIndex, ...(fingerprint !== undefined ? { fingerprint } : {}) } }, change: { [MARK[record]]: { set: 0 } } },
    ],
  };
}

function cases(bytes: Uint8Array) {
  const p = profile(bytes);
  return fc.record({
    bytes: fc.constant(bytes),
    record: fc.constantFrom<Rec>("Sector", "Thing"),
    // 偶尔用不存在的地图名或改大小写
    map: fc.oneof({ weight: 8, arbitrary: fc.constantFrom(...p.mapNames) }, { weight: 1, arbitrary: fc.constantFrom(...p.mapNames).map((m) => m.toLowerCase()) }, { weight: 1, arbitrary: fc.constant("MAP99") }),
    pick: fc.nat(),
    over: fc.integer({ min: 0, max: 3 }),
    outOfRange: fc.boolean(),
    fingerprint: json,
    other: json,
  });
}

describe.each(SAMPLES)("Feature: patch-engine, Property 5: 没有指纹的 pin 只按下标（%s）", (_label, sample) => {
  it("下标在范围内恰好选中该记录，fingerprintChecked 为 false；越界或作用域不存在为 CONFLICT_MISSING", () => {
    fc.assert(
      fc.property(sample.chain(cases), ({ bytes, record, map, pick, over, outOfRange }) => {
        const src = wadAdapter.open(bytes);
        const scope = src.scopes().find((s) => s.name.toUpperCase() === map.toUpperCase());
        const count = scope ? src.recordCount(scope.id, record) : 0;
        const index = outOfRange || count === 0 ? count + over : pick % count;
        const r = planPatch(bytes, pinPatch(record, map, index), wadAdapter);
        expect(r.pins).toEqual([expect.objectContaining({ operationId: "p", expectedIndex: index, fingerprintChecked: false })]);
        if (!scope || index >= count) {
          expect(r.issues).toEqual([expect.objectContaining({ code: "CONFLICT_MISSING", operationId: "p" })]);
          expect(r.pins[0]!.result).toBe("CONFLICT_MISSING");
          expect(r.changes).toEqual([]);
          return;
        }
        expect(r.issues).toEqual([]);
        expect(r.pins[0]).toMatchObject({ result: "EXACT", index, scope: scope.id });
        expect(r.changes).toHaveLength(1);
        expect(r.changes[0]).toMatchObject({ scope: scope.id, record, index, selection: { kind: "EXACT", expectedIndex: index, fingerprintChecked: false } });
      }),
      { numRuns: RUNS },
    );
  });
});

describe.each(SAMPLES)("Feature: relocation, 指纹校验（%s）", (_label, sample) => {
  it("形状不对的 fingerprint、Thing 的 fingerprint 都是 INVALID_PATCH，不被忽略；Patch_Hash 仍按规范 JSON 区分", () => {
    fc.assert(
      fc.property(sample.chain(cases), ({ bytes, record, map, pick, fingerprint, other }) => {
        const src = wadAdapter.open(bytes);
        const scope = src.scopes().find((s) => s.name.toUpperCase() === map.toUpperCase());
        fc.pre(scope !== undefined && src.recordCount(scope.id, record) > 0);
        const index = pick % src.recordCount(scope!.id, record);
        fc.pre(record === "Thing" || validateSectorFingerprint(fingerprint).length > 0);
        const r = planPatch(bytes, pinPatch(record, map, index, fingerprint), wadAdapter);
        expect(r.ok).toBe(false);
        expect(r.issues.length).toBeGreaterThan(0);
        for (const i of r.issues) {
          expect(i).toMatchObject({ code: "INVALID_PATCH", operationId: "p" });
          expect(i.path!.startsWith("/operations/0/select/pin/fingerprint")).toBe(true);
        }
        expect(r.changes).toEqual([]);
        expect(r.pins).toEqual([]);
        // 补丁本身的结构校验不认识指纹的形状，Patch_Hash 照常计算
        const a = pinPatch(record, map, index, fingerprint);
        const b = pinPatch(record, map, index, other);
        if (canon(fingerprint) !== canon(other)) expect(patchHash(b)).not.toBe(patchHash(a));
        else expect(patchHash(b)).toBe(patchHash(a));
      }),
      { numRuns: RUNS },
    );
  });

  it("带真实指纹的 pin：EXACT 且 score 为 1，或者另有相近的扇区时为 CONFLICT_AMBIGUOUS；从不选中别的扇区", () => {
    const { high, margin } = RELOCATION_THRESHOLDS;
    const exact = new Hits();
    fc.assert(
      fc.property(sample, fc.nat(), fc.nat(), (bytes, mapPick, pick) => {
        const src = wadAdapter.open(bytes);
        const scopes = src.scopes().filter((s) => src.recordCount(s.id, "Sector") > 0);
        fc.pre(scopes.length > 0);
        const scope = scopes[mapPick % scopes.length]!;
        const n = src.recordCount(scope.id, "Sector");
        const index = pick % n;
        const fp = src.fingerprints!.compute({ scope: scope.id, record: "Sector", index }) as SectorFingerprint;
        expect(validateSectorFingerprint(fp)).toEqual([]);
        const r = planPatch(bytes, pinPatch("Sector", scope.name, index, fp), wadAdapter);
        expect(r.pins).toHaveLength(1);
        const pin = r.pins[0]!;
        expect(pin.fingerprintChecked).toBe(true);
        // 其他扇区与它的相似度，按引擎的规则取 4 位小数
        const round = (s: number) => Math.round(s * 10000) / 10000;
        const others: number[] = [];
        for (let j = 0; j < n; j++) {
          if (j === index) continue;
          others.push(round(sectorFingerprintScore(fp, src.fingerprints!.compute({ scope: scope.id, record: "Sector", index: j }) as SectorFingerprint)));
        }
        const best = others.length === 0 ? -1 : Math.max(...others);
        // 自己的相似度为 1：其他扇区都低于 high 时唯一（1 - high 大于 margin，所以 margin 不起作用）
        expect(1 - high).toBeGreaterThan(margin);
        const unique = best < high;
        if (unique) {
          exact.hit();
          expect(pin).toMatchObject({ result: "EXACT", index, score: 1 });
          expect(r.issues).toEqual([]);
          expect(r.changes).toEqual([expect.objectContaining({ index, selection: { kind: "EXACT", expectedIndex: index, fingerprintChecked: true, score: 1 } })]);
        } else {
          expect(best).toBeGreaterThanOrEqual(high);
          expect(pin.result).toBe("CONFLICT_AMBIGUOUS");
          expect(pin.index).toBeUndefined();
          expect(pin.candidates.some((c) => c.index === index && c.score === 1)).toBe(true);
          expect(r.issues).toEqual([expect.objectContaining({ code: "CONFLICT_AMBIGUOUS", operationId: "p", path: "/operations/0/select/pin/fingerprint" })]);
          expect(r.changes).toEqual([]);
        }
      }),
      { numRuns: RUNS },
    );
    // 生成样本没有几何数据，扇区常常彼此一样；Freedoom 夹具上大部分扇区应当是唯一的
    if (_label === "Freedoom 夹具") expect(exact.n).toBeGreaterThan(RUNS / 2);
  });
});

describe("Feature: patch-engine, Property 5: pin 只按下标（同名地图）", () => {
  it("dupMapWad 上 pin 该名称为 CONFLICT_AMBIGUOUS，不猜测", () => {
    fc.assert(
      fc.property(dupMapWad, fc.nat(), fc.boolean(), ({ bytes, name, sectorCount }, pick, lower) => {
        const r = planPatch(bytes, pinPatch("Sector", lower ? name.toLowerCase() : name, pick % sectorCount), wadAdapter);
        expect(r.issues).toEqual([expect.objectContaining({ code: "CONFLICT_AMBIGUOUS", operationId: "p" })]);
        expect(r.changes).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });
});
