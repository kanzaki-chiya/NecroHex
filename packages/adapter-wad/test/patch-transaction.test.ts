import { applyPatch } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { wadAdapter } from "../src/index.ts";
import { patchFor } from "./arbitraries.ts";
import { Hits, jsonCopy, RUNS, SAMPLES, sameBytes } from "./patch-helpers.ts";

type Json = Record<string, unknown>;
type Problem = "out-of-range" | "too-long-name" | "double-write" | "special";

/** 从补丁里去掉所有对 Sector.<field> 的写入，使注入的问题不被别的操作的冲突掩盖。 */
function without(patch: Json, field: string): Json {
  const p = jsonCopy(patch);
  const ops = (p.operations as Json[])
    .map((o) => {
      if ((o.select as Json).record !== "Sector") return o;
      const change = { ...(o.change as Json) };
      delete change[field];
      return { ...o, change };
    })
    .filter((o) => Object.keys(o.change as Json).length > 0);
  return { ...p, operations: ops };
}

/** 在副本上注入一个问题，返回补丁和期望的问题代码、操作 id。 */
function inject(bytes: Uint8Array, patch: Json, problem: Problem, pick: number): { patch: Json; code: string; ids: string[] } | null {
  const src = wadAdapter.open(bytes);
  const scope = src.scopes()[0]!;
  const n = src.recordCount(scope.id, "Sector");
  if (n === 0) return null;
  const index = pick % n;
  const pin = { record: "Sector", pin: { map: scope.name, expectedIndex: index } };
  const add = (field: string, ...ops: Json[]) => {
    const base = without(patch, field);
    return { ...base, target: { format: "wad", maps: "*" }, operations: [...(base.operations as Json[]), ...ops] };
  };
  switch (problem) {
    case "out-of-range":
      return { patch: add("lightlevel", { id: "bad", select: pin, change: { lightlevel: { set: 40000 } } }), code: "VALUE_REJECTED", ids: ["bad"] };
    case "too-long-name":
      return { patch: add("floorpic", { id: "bad", select: pin, change: { floorpic: { set: "TOOLONGNAME" } } }), code: "VALUE_REJECTED", ids: ["bad"] };
    case "double-write":
      return {
        patch: add("tag", { id: "w1", select: pin, change: { tag: { set: 1 } } }, { id: "w2", select: pin, change: { tag: { set: 2 } } }),
        code: "CONFLICT_FIELD",
        ids: ["w1", "w2"],
      };
    case "special": {
      // 找一个 special 非零的扇区
      let at = -1;
      for (let k = 0; k < n; k++) {
        const i = (pick + k) % n;
        if (src.readField({ scope: scope.id, record: "Sector", index: i }, "special") !== 0) {
          at = i;
          break;
        }
      }
      if (at < 0) return null;
      const p = add("special", { id: "bad", select: { record: "Sector", pin: { map: scope.name, expectedIndex: at } }, change: { special: { set: 0 } } });
      delete (p as Json).allowProtected;
      return { patch: p, code: "PROTECTED", ids: ["bad"] };
    }
  }
}

describe.each(SAMPLES)("Feature: patch-engine, Property 8: 事务性（%s）", (_label, sample) => {
  it("输入不变；有问题时没有字节和回执", () => {
    fc.assert(
      fc.property(sample.chain((bytes) => patchFor(bytes).map((patch) => ({ bytes, patch }))), ({ bytes, patch }) => {
        const before = bytes.slice();
        const r = applyPatch(bytes, patch, wadAdapter);
        expect(sameBytes(bytes, before)).toBe(true);
        if (r.issues.length > 0) {
          expect(r.ok).toBe(false);
          expect(r.output).toBeUndefined();
          expect(r.receipt).toBeUndefined();
        } else {
          expect(r.output).not.toBe(bytes);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it.each<Problem>(["out-of-range", "too-long-name", "double-write", "special"])("注入 %s：问题含对应代码和 id，无字节", (problem) => {
    const hits = new Hits();
    fc.assert(
      fc.property(sample.chain((bytes) => patchFor(bytes).map((patch) => ({ bytes, patch }))), fc.nat(), ({ bytes, patch }, pick) => {
        const injected = inject(bytes, patch, problem, pick);
        if (!injected) return;
        hits.hit();
        const before = bytes.slice();
        const r = applyPatch(bytes, injected.patch, wadAdapter);
        expect(sameBytes(bytes, before)).toBe(true);
        expect(r.ok).toBe(false);
        expect(r.output).toBeUndefined();
        expect(r.receipt).toBeUndefined();
        const found = r.issues.filter((i) => i.code === injected.code);
        expect(found.length).toBeGreaterThan(0);
        if (injected.code === "CONFLICT_FIELD") expect(found.some((i) => JSON.stringify(i.operationIds) === JSON.stringify(injected.ids))).toBe(true);
        else expect(found.some((i) => i.operationId === injected.ids[0])).toBe(true);

        if (problem === "special") {
          // opt-in 后 PROTECTED 消失
          const optIn = applyPatch(bytes, { ...injected.patch, allowProtected: ["sector-special-nonzero"] }, wadAdapter);
          expect(optIn.issues.some((i) => i.code === "PROTECTED")).toBe(false);
        }
      }),
      { numRuns: RUNS },
    );
    expect(hits.n).toBeGreaterThan(0);
  });
});
