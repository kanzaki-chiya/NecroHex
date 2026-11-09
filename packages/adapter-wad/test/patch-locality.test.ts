import { applyPatch } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { wadAdapter } from "../src/index.ts";
import { patchFor } from "./arbitraries.ts";
import { Hits, RUNS, SAMPLES } from "./patch-helpers.ts";

const ENTRY_KEYS = ["field", "index", "newValue", "oldValue", "operationId", "record", "scope", "selection", "span", "unchanged"];

describe.each(SAMPLES)("Feature: patch-engine, Property 1: I-3 局部性（%s）", (_label, sample) => {
  it("不同字节都在某条目的 span 内，span 等于 fieldSpan，条目字段齐全", () => {
    const ok = new Hits();
    fc.assert(
      fc.property(sample.chain((bytes) => patchFor(bytes, { validOnly: true }).map((patch) => ({ bytes, patch }))), ({ bytes, patch }) => {
        const r = applyPatch(bytes, patch, wadAdapter);
        if (!r.ok) return;
        ok.hit();
        const out = r.output!;
        expect(out.length).toBe(bytes.length);
        const entries = r.receipt!.entries;
        const reader = wadAdapter.open(bytes);
        for (const e of entries) {
          expect(Object.keys(e).sort()).toEqual(ENTRY_KEYS);
          expect(reader.fieldSpan({ scope: e.scope, record: e.record, index: e.index }, e.field)).toEqual(e.span);
        }
        const spans = entries.map((e) => e.span).sort((a, b) => a.start - b.start);
        for (let i = 0; i < out.length; i++) {
          if (out[i] === bytes[i]) continue;
          expect(spans.some((s) => i >= s.start && i < s.end), `byte ${i} changed outside every entry span`).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
    expect(ok.n).toBeGreaterThan(0);
  });
});
