import { applyPatch, revertPatch } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { wadAdapter } from "../src/index.ts";
import { patchFor } from "./arbitraries.ts";
import { Hits, jsonCopy, RUNS, SAMPLES, sameBytes } from "./patch-helpers.ts";

describe.each(SAMPLES)("Feature: patch-engine, Property 2: I-4 可撤销（%s）", (_label, sample) => {
  it("按 JSON 往返后的回执撤销，结果与输入逐字节相同", () => {
    const ok = new Hits();
    fc.assert(
      fc.property(sample.chain((bytes) => patchFor(bytes, { validOnly: true }).map((patch) => ({ bytes, patch }))), ({ bytes, patch }) => {
        const r = applyPatch(bytes, patch, wadAdapter);
        if (!r.ok) return;
        ok.hit();
        const back = revertPatch(r.output!, jsonCopy(r.receipt), wadAdapter);
        expect(back.issues).toEqual([]);
        expect(back.ok).toBe(true);
        expect(sameBytes(back.output!, bytes)).toBe(true);
      }),
      { numRuns: RUNS },
    );
    expect(ok.n).toBeGreaterThan(0);
  });
});
