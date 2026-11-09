import { createHash } from "node:crypto";
import { applyPatch, bytesHash, patchHash } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { wadAdapter } from "../src/index.ts";
import { patchFor } from "./arbitraries.ts";
import { Hits, jsonCopy, RUNS, SAMPLES } from "./patch-helpers.ts";

/** 递归打乱对象键顺序（按 seed 决定反转与否），值不变。 */
function reorder(v: unknown, seed: number): unknown {
  if (Array.isArray(v)) return v.map((x, i) => reorder(x, seed + i));
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    const ordered = seed % 2 === 0 ? keys.reverse() : [...keys.slice(1), ...keys.slice(0, 1)];
    return Object.fromEntries(ordered.map((k, i) => [k, reorder((v as Record<string, unknown>)[k], seed + i + 1)]));
  }
  return v;
}

describe.each(SAMPLES)("Feature: patch-engine, Property 10: 回执哈希与重复应用（%s）", (_label, sample) => {
  it("三个哈希正确；重排键或改空白不改变 Patch_Hash；带回执对输出再应用为 ALREADY_APPLIED", () => {
    const ok = new Hits();
    fc.assert(
      fc.property(
        sample.chain((bytes) => patchFor(bytes, { validOnly: true }).map((patch) => ({ bytes, patch }))),
        fc.nat(),
        fc.integer({ min: 0, max: 8 }),
        ({ bytes, patch }, seed, indent) => {
          const r = applyPatch(bytes, patch, wadAdapter);
          if (!r.ok) return;
          ok.hit();
          const receipt = r.receipt!;
          expect(receipt.inputHash).toBe(bytesHash(bytes));
          expect(receipt.outputHash).toBe(bytesHash(r.output!));
          expect(receipt.patchHash).toBe(patchHash(patch));
          // 与参考实现交叉核对
          expect(receipt.outputHash).toBe("sha256:" + createHash("sha256").update(r.output!).digest("hex"));
          for (const h of [receipt.inputHash, receipt.outputHash, receipt.patchHash]) expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);

          const reformatted = JSON.parse(JSON.stringify(reorder(patch, seed), null, indent));
          expect(patchHash(reformatted)).toBe(receipt.patchHash);

          const again = applyPatch(r.output!, reformatted, wadAdapter, { receipts: [jsonCopy(receipt)] });
          expect(again.ok).toBe(false);
          expect(again.issues).toEqual([expect.objectContaining({ code: "ALREADY_APPLIED" })]);
          expect(again.output).toBeUndefined();
        },
      ),
      { numRuns: RUNS },
    );
    expect(ok.n).toBeGreaterThan(0);
  });
});
