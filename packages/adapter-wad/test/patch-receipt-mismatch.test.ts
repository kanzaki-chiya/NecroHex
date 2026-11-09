import { applyPatch, revertPatch, type Receipt } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { wadAdapter } from "../src/index.ts";
import { patchFor } from "./arbitraries.ts";
import { Hits, jsonCopy, RUNS, SAMPLES } from "./patch-helpers.ts";

type Json = Record<string, unknown>;

/** 破坏 Receipt 结构的单处变异。 */
const BREAKS: Array<(r: Json, n: number) => Json | null> = [
  (r) => ({ ...r, receiptVersion: 2 }),
  (r) => ({ ...r, extra: true }),
  (r, n) => {
    const k = ["receiptVersion", "patchName", "patchHash", "inputHash", "outputHash", "allowedProtections", "entries"][n % 7]!;
    const c = { ...r };
    delete c[k];
    return c;
  },
  (r) => ({ ...r, outputHash: (r.outputHash as string).replace("sha256:", "md5:") }),
  (r) => ({ ...r, inputHash: (r.inputHash as string).slice(0, -1) }),
  (r) => ({ ...r, allowedProtections: "sector-special-nonzero" }),
  (r) => ({ ...r, entries: {} }),
  (r, n) => {
    const entries = r.entries as Json[];
    if (entries.length === 0) return null;
    const i = n % entries.length;
    const mut: Array<(e: Json) => Json> = [
      (e) => ({ ...e, unchanged: 0 }),
      (e) => ({ ...e, index: -1 }),
      (e) => ({ ...e, index: 1.5 }),
      (e) => ({ ...e, span: { start: 5, end: 2 } }),
      (e) => ({ ...e, span: { start: 1, end: 2, length: 1 } }),
      (e) => ({ ...e, selection: { kind: "RELOCATED" } }),
      (e) => ({ ...e, selection: { kind: "EXACT", expectedIndex: 0, fingerprintChecked: true } }),
      (e) => ({ ...e, oldValue: null }),
      (e) => ({ ...e, newValue: [1] }),
      (e) => ({ ...e, offset: 12 }),
      (e) => {
        const c = { ...e };
        delete c.field;
        return c;
      },
    ];
    return { ...r, entries: entries.map((e, j) => (j === i ? mut[n % mut.length]!(e) : e)) };
  },
];

describe.each(SAMPLES)("Feature: patch-engine, Property 11: 回执不匹配（%s）", (_label, sample) => {
  const applied = sample.chain((bytes) => patchFor(bytes, { validOnly: true }).map((patch) => ({ bytes, patch })));

  it("改 output 任一字节后撤销为 RECEIPT_MISMATCH，无字节", () => {
    const ok = new Hits();
    fc.assert(
      fc.property(applied, fc.nat(), fc.integer({ min: 1, max: 255 }), ({ bytes, patch }, at, delta) => {
        const r = applyPatch(bytes, patch, wadAdapter);
        if (!r.ok) return;
        ok.hit();
        const tampered = r.output!.slice();
        const i = at % tampered.length;
        tampered[i] = (tampered[i]! + delta) & 0xff;
        const back = revertPatch(tampered, jsonCopy(r.receipt), wadAdapter);
        expect(back.ok).toBe(false);
        expect(back.output).toBeUndefined();
        expect(back.issues).toEqual([expect.objectContaining({ code: "RECEIPT_MISMATCH" })]);
      }),
      { numRuns: RUNS },
    );
    expect(ok.n).toBeGreaterThan(0);
  });

  it("破坏 Receipt 结构后撤销或用作 options.receipts 为 INVALID_RECEIPT，无字节", () => {
    const ok = new Hits();
    fc.assert(
      fc.property(applied, fc.nat(BREAKS.length - 1), fc.nat(), ({ bytes, patch }, which, n) => {
        const r = applyPatch(bytes, patch, wadAdapter);
        if (!r.ok) return;
        const broken = BREAKS[which]!(jsonCopy(r.receipt) as unknown as Json, n);
        if (!broken) return;
        ok.hit();
        const back = revertPatch(r.output!, broken, wadAdapter);
        expect(back.ok).toBe(false);
        expect(back.output).toBeUndefined();
        expect(back.issues.length).toBeGreaterThan(0);
        expect(back.issues.every((i) => i.code === "INVALID_RECEIPT")).toBe(true);
        const again = applyPatch(r.output!, patch, wadAdapter, { receipts: [broken as unknown as Receipt] });
        expect(again.ok).toBe(false);
        expect(again.output).toBeUndefined();
        expect(again.issues.every((i) => i.code === "INVALID_RECEIPT")).toBe(true);
      }),
      { numRuns: RUNS },
    );
    expect(ok.n).toBeGreaterThan(0);
  });
});
