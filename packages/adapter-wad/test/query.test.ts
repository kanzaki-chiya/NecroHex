/**
 * queryRecords（core 的只读查询）：与补丁共用选择器的校验和求值，CLI 的 query 和 MCP 的 query_entities 建立在它上面。
 */
import { planPatch, queryRecords, type Selector } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { wadAdapter } from "../src/index.ts";
import { patchFor } from "./arbitraries.ts";
import { FIXTURE, Hits, RUNS, SAMPLES, sameBytes } from "./patch-helpers.ts";

describe.each(SAMPLES)("queryRecords 与补丁选中同样的记录（%s）", (_label, sample) => {
  it("补丁干跑通过时，每个操作的查询结果等于该操作 changes 里出现的记录；输入不被修改", () => {
    const ok = new Hits();
    fc.assert(
      fc.property(sample.chain((bytes) => patchFor(bytes, { validOnly: true }).map((patch) => ({ bytes, patch }))), ({ bytes, patch }) => {
        const copy = bytes.slice();
        const plan = planPatch(bytes, patch, wadAdapter);
        if (!plan.ok) return;
        ok.hit();
        const p = patch as { target: { maps: "*" | string[] }; operations: Array<{ id: string; select: Selector }> };
        for (const op of p.operations) {
          const q = queryRecords(bytes, { maps: p.target.maps, select: op.select }, wadAdapter);
          expect(q.issues).toEqual([]);
          const fromPlan = [...new Map(plan.changes.filter((c) => c.operationId === op.id).map((c) => [`${c.scope}/${c.index}`, { scope: c.scope, record: c.record, index: c.index }])).values()];
          expect(q.records.map((r) => r.locator)).toEqual(fromPlan);
        }
        expect(sameBytes(bytes, copy)).toBe(true);
      }),
      { numRuns: RUNS },
    );
    expect(ok.n).toBeGreaterThan(0);
  });
});

describe("queryRecords 固定样例（Freedoom 夹具）", () => {
  it("按条件查询 MAP01 的玩家 1 出生点", () => {
    const q = queryRecords(FIXTURE, { maps: ["MAP01"], select: { record: "Thing", where: { type: { eq: 1 } } } }, wadAdapter);
    expect(q.ok).toBe(true);
    expect(q.records).toHaveLength(1);
    expect(q.records[0]!.locator.scope).toBe("MAP01");
  });

  it("只读记录也能查询；补丁里它们不能被选中改写", () => {
    const q = queryRecords(FIXTURE, { maps: ["MAP01"], select: { record: "Linedef", all: true } }, wadAdapter);
    expect(q.ok).toBe(true);
    expect(q.records.length).toBeGreaterThan(0);
  });

  it("非法查询为 INVALID_PATCH，路径相对查询对象，不带 operationId", () => {
    const q = queryRecords(FIXTURE, { select: { record: "Sector", where: { nope: { eq: 1 } } } }, wadAdapter);
    expect(q.ok).toBe(false);
    expect(q.issues).toEqual([{ code: "INVALID_PATCH", message: "Sector has no field nope", path: "/select/where/nope" }]);
    const shape = queryRecords(FIXTURE, { select: { record: "Sector", offset: 12 } }, wadAdapter);
    expect(shape.issues.map((i) => i.path)).toContain("/select/offset");
  });

  it("pin 查询返回 pin 结果；不存在的地图为 CONFLICT_MISSING", () => {
    const q = queryRecords(FIXTURE, { select: { record: "Sector", pin: { map: "MAP01", expectedIndex: 0 } } }, wadAdapter);
    expect(q.pins).toEqual([expect.objectContaining({ result: "EXACT", index: 0 })]);
    const missing = queryRecords(FIXTURE, { maps: ["MAP99"], select: { record: "Sector", all: true } }, wadAdapter);
    expect(missing.ok).toBe(false);
    expect(missing.issues).toEqual([expect.objectContaining({ code: "CONFLICT_MISSING", path: "/target/maps/0" })]);
  });
});
