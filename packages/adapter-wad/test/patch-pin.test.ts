import { patchHash, planPatch } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { wadAdapter } from "../src/index.ts";
import { dupMapWad, profile } from "./arbitraries.ts";
import { BLOCK_HOOKS, RUNS, SAMPLES } from "./patch-helpers.ts";

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
    fingerprint: fc.option(json, { nil: undefined }),
    other: json,
  });
}

describe.each(SAMPLES)("Feature: patch-engine, Property 5: pin 只按下标（%s）", (_label, sample) => {
  it("下标在范围内恰好选中该记录；越界或作用域不存在为 CONFLICT_MISSING", () => {
    fc.assert(
      fc.property(sample.chain(cases), ({ bytes, record, map, pick, over, outOfRange, fingerprint }) => {
        const src = wadAdapter.open(bytes);
        const scope = src.scopes().find((s) => s.name.toUpperCase() === map.toUpperCase());
        const count = scope ? src.recordCount(scope.id, record) : 0;
        const index = outOfRange || count === 0 ? count + over : pick % count;
        const r = planPatch(bytes, pinPatch(record, map, index, fingerprint), wadAdapter);
        if (!scope || index >= count) {
          expect(r.issues).toEqual([expect.objectContaining({ code: "CONFLICT_MISSING", operationId: "p" })]);
          expect(r.changes).toEqual([]);
          return;
        }
        expect(r.issues).toEqual([]);
        expect(r.changes).toHaveLength(1);
        expect(r.changes[0]).toMatchObject({ scope: scope.id, record, index, selection: { kind: "EXACT", expectedIndex: index, fingerprintChecked: false } });
      }),
      { numRuns: RUNS },
    );
  });

  it("换 fingerprint 不改变匹配，但改变 Patch_Hash", () => {
    fc.assert(
      fc.property(sample.chain(cases), ({ bytes, record, map, pick, fingerprint, other }) => {
        const src = wadAdapter.open(bytes);
        const scope = src.scopes().find((s) => s.name.toUpperCase() === map.toUpperCase());
        fc.pre(scope !== undefined && src.recordCount(scope.id, record) > 0);
        const index = pick % src.recordCount(scope!.id, record);
        const a = pinPatch(record, map, index, fingerprint);
        const b = pinPatch(record, map, index, other);
        expect(planPatch(bytes, b, wadAdapter).changes).toEqual(planPatch(bytes, a, wadAdapter).changes);
        // fingerprint 的规范形式不同，Patch_Hash 就不同；相同（只差键序）则 Patch_Hash 相同
        if (canon(fingerprint) !== canon(other)) expect(patchHash(b)).not.toBe(patchHash(a));
        else expect(patchHash(b)).toBe(patchHash(a));
      }),
      { numRuns: RUNS },
    );
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
