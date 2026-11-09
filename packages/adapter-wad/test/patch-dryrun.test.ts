import { applyPatch, planPatch } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { wadAdapter } from "../src/index.ts";
import { patchFor } from "./arbitraries.ts";
import { RUNS, SAMPLES } from "./patch-helpers.ts";

describe.each(SAMPLES)("Feature: patch-engine, Property 9: 干跑等价（%s）", (_label, sample) => {
  it("planPatch 与 applyPatch 的 ok、issues、warnings、matches、changes、changedCount 深相等，planPatch 不含字节", () => {
    fc.assert(
      fc.property(sample.chain((bytes) => patchFor(bytes).map((patch) => ({ bytes, patch }))), ({ bytes, patch }) => {
        const plan = planPatch(bytes, patch, wadAdapter);
        const { output, receipt, ...applied } = applyPatch(bytes, patch, wadAdapter);
        expect(plan).toEqual(applied);
        expect("output" in plan).toBe(false);
        expect("receipt" in plan).toBe(false);
        expect(output !== undefined).toBe(applied.ok);
        expect(receipt !== undefined).toBe(applied.ok);
        expect(plan.changedCount).toBe(plan.changes.filter((c) => !c.unchanged).length);
        for (const c of plan.changes) expect(typeof c.unchanged).toBe("boolean");
      }),
      { numRuns: RUNS },
    );
  });
});
