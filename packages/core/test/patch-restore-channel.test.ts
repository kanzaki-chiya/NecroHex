import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyPatch, planPatch, revertPatch, type Receipt } from "../src/index.ts";
import { encodeModel, key, makeFake, sampleModel } from "./fake-source.ts";

const change = fc.oneof(
  fc.constant({ lightlevel: { scale: 0.5 } }),
  fc.integer({ min: -5, max: 300 }).map((v) => ({ tag: { set: v } })),
  fc.constantFrom("FLAT1", "BLOOD1").map((v) => ({ floorpic: { set: v } })),
);
const patch = fc.record({ change, maps: fc.constantFrom<"*" | string[]>("*", ["MAP01"], ["MAP02"]) }).map(({ change, maps }) => ({
  schemaVersion: 1,
  name: "r",
  target: { format: "fake", maps },
  operations: [{ id: "all", select: { record: "Sector", all: true }, change }],
}));

type Tamper = "newValue" | "span" | "outputHash";

function tamper(r: Receipt, what: Tamper, n: number): Receipt {
  const copy = JSON.parse(JSON.stringify(r)) as { outputHash: string; entries: Array<Record<string, unknown>> };
  const i = n % copy.entries.length;
  const e = copy.entries[i]!;
  if (what === "newValue") e.newValue = typeof e.newValue === "number" ? e.newValue + 1 : `${String(e.newValue)}X`;
  else if (what === "span") {
    const s = e.span as { start: number; end: number };
    e.span = { start: s.start + 1, end: s.end + 1 };
  } else {
    const h = copy.outputHash;
    const last = h[h.length - 1] === "0" ? "1" : "0";
    copy.outputHash = h.slice(0, -1) + last;
  }
  return copy as unknown as Receipt;
}

describe("Feature: patch-engine, Property 14: 写回通道只在核对通过后由撤销调用", () => {
  it("应用和干跑不调用 restoreField；未改动的回执撤销成功", () => {
    fc.assert(
      fc.property(patch, (p) => {
        const fake = makeFake();
        const input = encodeModel(sampleModel());
        planPatch(input, p, fake.adapter);
        const a = applyPatch(input, p, fake.adapter);
        expect(a.ok).toBe(true);
        expect(fake.counts.restoreField).toBe(0);
        expect(fake.counts.restorableOpen).toBe(0);
        const r = revertPatch(a.output!, JSON.parse(JSON.stringify(a.receipt)), fake.adapter);
        expect(r.ok).toBe(true);
        expect([...r.output!]).toEqual([...input]);
        expect(fake.counts.restoreField).toBe(a.receipt!.entries.length);
      }),
      { numRuns: 100 },
    );
  });

  it("改任一条 newValue、span 或 outputHash 后撤销：RECEIPT_MISMATCH，restoreField 调用 0 次", () => {
    fc.assert(
      fc.property(patch, fc.constantFrom<Tamper>("newValue", "span", "outputHash"), fc.nat(100), (p, what, n) => {
        const fake = makeFake();
        const a = applyPatch(encodeModel(sampleModel()), p, fake.adapter);
        expect(a.ok).toBe(true);
        const r = revertPatch(a.output!, tamper(a.receipt!, what, n), fake.adapter);
        expect(r.ok).toBe(false);
        expect(r.output).toBeUndefined();
        expect(r.issues.length).toBeGreaterThan(0);
        expect(r.issues.every((i) => i.code === "RECEIPT_MISMATCH")).toBe(true);
        expect(fake.counts.restoreField).toBe(0);
      }),
      { numRuns: 150 },
    );
  });

  it("某条 restoreField 失败：RECEIPT_MISMATCH，带该条 locator 和 field，无字节", () => {
    fc.assert(
      fc.property(patch, fc.nat(100), (p, n) => {
        // 先跑一次得到条目，再挑一条让写回失败
        const probe = applyPatch(encodeModel(sampleModel()), p, makeFake().adapter);
        const target = probe.changes[n % probe.changes.length]!;
        const loc = { scope: target.scope, record: target.record, index: target.index };
        const fake = makeFake({ restoreFails: [key(loc, target.field)] });
        const a = applyPatch(encodeModel(sampleModel()), p, fake.adapter);
        expect(a.ok).toBe(true);
        const r = revertPatch(a.output!, a.receipt, fake.adapter);
        expect(r.ok).toBe(false);
        expect(r.output).toBeUndefined();
        expect(r.issues).toEqual([expect.objectContaining({ code: "RECEIPT_MISMATCH", locator: loc, field: target.field })]);
      }),
      { numRuns: 100 },
    );
  });
});
