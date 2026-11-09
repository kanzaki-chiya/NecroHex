import { applyPatch, planPatch } from "@necrohex/core";
import { describe, expect, it } from "vitest";
import { wadAdapter } from "../src/index.ts";
import { countingAdapter, FIXTURE } from "./patch-helpers.ts";

const patch = (select: Record<string, unknown>) => ({
  schemaVersion: 1,
  name: "shape",
  target: { format: "wad", maps: ["MAP01"] },
  operations: [{ id: "dim", select: { record: "Sector", ...select }, change: { lightlevel: { scale: 0.5 } } }],
});

describe("选择器形状（Freedoom 夹具）", () => {
  it.each([
    ["where: {}", { where: {} }, "/operations/0/select/where"],
    ["空字段条件", { where: { lightlevel: {} } }, "/operations/0/select/where/lightlevel"],
    ["all: false", { all: false }, "/operations/0/select/all"],
    ['all: "true"', { all: "true" }, "/operations/0/select/all"],
    ["all: 1", { all: 1 }, "/operations/0/select/all"],
    ["all: null", { all: null }, "/operations/0/select/all"],
    ["where 和 all 同时出现", { where: { lightlevel: { gte: 1 } }, all: true }, "/operations/0/select"],
    ["三者都没有", {}, "/operations/0/select"],
  ])("%s 为 INVALID_PATCH，不打开 Record_Source", (_name, select, path) => {
    const { adapter, opens } = countingAdapter();
    for (const run of [planPatch, applyPatch]) {
      const r = run(FIXTURE, patch(select), adapter);
      expect(r.ok).toBe(false);
      expect(r.issues).toEqual([expect.objectContaining({ code: "INVALID_PATCH", operationId: "dim", path })]);
      expect((r as { output?: unknown }).output).toBeUndefined();
    }
    expect(opens()).toBe(0);
  });

  it("对照：all: true 选中 MAP01 全部扇区", () => {
    const r = planPatch(FIXTURE, patch({ all: true }), wadAdapter);
    expect(r.ok).toBe(true);
    const src = wadAdapter.open(FIXTURE);
    expect(r.matches).toEqual([{ operationId: "dim", count: src.recordCount("MAP01", "Sector") }]);
  });
});
