import { applyPatch } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { wadAdapter } from "../src/index.ts";
import { setOnlyPatchFor } from "./arbitraries.ts";
import { Hits, RUNS, SAMPLES, sameBytes } from "./patch-helpers.ts";

interface Op {
  select: { record: string; where?: Record<string, unknown>; pin?: { fingerprint?: unknown } };
  change: Record<string, { set?: unknown }>;
}

/** Sector 指纹读取的字段（几何中心和线段数来自不可写的 Lump）。 */
const FINGERPRINT_FIELDS = ["tag", "floorpic", "ceilingpic", "floorheight", "ceilingheight"];

/**
 * 前提：没有选择器读取补丁写入的 (record, field)。
 * - where 读取另一个操作写入的字段：第二次应用时选择器按 O 的值求值，会选中第一次没选中的记录（见 regression.test.ts 的 P3-1）。
 * - 带指纹的 pin 读取任一操作（包括它自己）写入的指纹字段：第二次应用时记录已不再符合指纹，pin 解析为冲突（P3-3）。
 */
function noCrossOperationReads(patch: Record<string, unknown>): boolean {
  const ops = patch.operations as Op[];
  const whereOk = ops.every((reader, i) =>
    Object.keys(reader.select.where ?? {}).every((field) =>
      ops.every((writer, j) => j === i || writer.select.record !== reader.select.record || !(field in writer.change)),
    ),
  );
  const pinOk = ops.every(
    (reader) =>
      reader.select.record !== "Sector" ||
      reader.select.pin?.fingerprint === undefined ||
      ops.every((writer) => writer.select.record !== "Sector" || FINGERPRINT_FIELDS.every((f) => !(f in writer.change))),
  );
  return whereOk && pinOk;
}

/** 补丁是否把某个 Sector.special 设成非零值：第二次应用时这个值是"旧值非零"，受 sector-special-nonzero 保护（P3-2）。 */
function setsNonzeroSpecial(patch: Record<string, unknown>): boolean {
  return (patch.operations as Op[]).some((op) => op.select.record === "Sector" && op.change.special !== undefined && op.change.special.set !== 0);
}

describe.each(SAMPLES)("Feature: patch-engine, Property 3: set 幂等（%s）", (_label, sample) => {
  it("只含 set、没有跨操作读取的补丁应用得到 O 后，以 allowReapply 再应用仍得 O", () => {
    const ok = new Hits();
    const arb = sample.chain((bytes) => setOnlyPatchFor(bytes, { validOnly: true }).filter(noCrossOperationReads).map((patch) => ({ bytes, patch })));
    fc.assert(
      fc.property(arb, ({ bytes, patch }) => {
        const first = applyPatch(bytes, patch, wadAdapter);
        if (!first.ok) return;
        ok.hit();
        const second = applyPatch(first.output!, patch, wadAdapter, { allowReapply: true, receipts: [first.receipt] });
        if (!second.ok && setsNonzeroSpecial(patch) && !patch.allowProtected) {
          // 唯一允许的差别：第一次写入的非零 special 在第二次被保护；显式 opt-in 后结果仍是 O
          expect(second.issues.every((i) => i.code === "PROTECTED" && i.hook === "sector-special-nonzero" && i.field === "special")).toBe(true);
          const optIn = { ...patch, allowProtected: ["sector-special-nonzero"] };
          const third = applyPatch(first.output!, optIn, wadAdapter, { allowReapply: true });
          expect(third.issues).toEqual([]);
          expect(sameBytes(third.output!, first.output!)).toBe(true);
          return;
        }
        expect(second.issues).toEqual([]);
        expect(sameBytes(second.output!, first.output!)).toBe(true);
      }),
      { numRuns: RUNS },
    );
    expect(ok.n).toBeGreaterThan(0);
  });
});
