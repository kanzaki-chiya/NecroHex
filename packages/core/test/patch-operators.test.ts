import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeNewValue } from "../src/patch/operators.ts";

const int = fc.integer({ min: -40000, max: 70000 });
const k = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1000, max: 1000 });
const bounds = fc.tuple(int, int).map(([a, b]) => (a <= b ? [a, b] : [b, a]) as [number, number]);

describe("Feature: patch-engine, Property 6: 算子计算", () => {
  it("set 取给定值", () => {
    fc.assert(
      fc.property(int, fc.oneof(int, fc.string({ maxLength: 8 })), (old, v) => {
        expect(computeNewValue({ set: v }, old)).toBe(v);
      }),
      { numRuns: 200 },
    );
  });

  it("scale 为 floor(old * k)，有 clamp 时再限制", () => {
    fc.assert(
      fc.property(int, k, fc.option(bounds, { nil: undefined }), (old, scale, clamp) => {
        const floor = Math.floor(old * scale);
        const want = clamp ? Math.min(Math.max(floor, clamp[0]), clamp[1]) : floor;
        expect(computeNewValue(clamp ? { scale, clamp } : { scale }, old)).toBe(want);
      }),
      { numRuns: 300 },
    );
  });

  it("只有 clamp 时为 min(max(old, lo), hi)", () => {
    fc.assert(
      fc.property(int, bounds, (old, [lo, hi]) => {
        const v = computeNewValue({ clamp: [lo, hi] }, old);
        expect(v).toBe(Math.min(Math.max(old, lo), hi));
        expect(v).toBeGreaterThanOrEqual(lo);
        expect(v).toBeLessThanOrEqual(hi);
      }),
      { numRuns: 300 },
    );
  });

  it("例子：scale 0.5 clamp [32, 255]", () => {
    expect(computeNewValue({ scale: 0.5, clamp: [32, 255] }, 255)).toBe(127);
    expect(computeNewValue({ scale: 0.5, clamp: [32, 255] }, 161)).toBe(80);
    expect(computeNewValue({ scale: 0.5, clamp: [32, 255] }, 40)).toBe(32);
    expect(computeNewValue({ scale: 0.5 }, -3)).toBe(-2);
  });
});
