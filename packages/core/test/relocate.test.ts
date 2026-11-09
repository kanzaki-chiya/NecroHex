import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classifyPin, RELOCATION_THRESHOLDS } from "../src/patch/relocate.ts";
import { validateReceipt } from "../src/patch/receipt.ts";

const T = RELOCATION_THRESHOLDS;

describe("classifyPin", () => {
  it("初始阈值为 0.85 和 0.5，唯一候选与第二名至少差 0.1", () => {
    expect(T).toEqual({ high: 0.85, low: 0.5, margin: 0.1 });
  });

  it.each([
    ["下标处唯一的高置信度候选", [1, 0.3, 0.6], 0, { result: "EXACT", index: 0, score: 1 }],
    ["别处唯一的高置信度候选", [0.2, 0.3, 0.9], 0, { result: "RELOCATED", index: 2, score: 0.9 }],
    ["下标越界时仍可重定位", [0.95], 5, { result: "RELOCATED", index: 0, score: 0.95 }],
    ["两个并列第一", [1, 1], 0, { result: "CONFLICT_AMBIGUOUS" }],
    ["两个高置信度候选", [0.95, 0.86], 0, { result: "CONFLICT_AMBIGUOUS" }],
    ["第二名离第一名不到 margin", [0.93, 0.84], 0, { result: "CONFLICT_AMBIGUOUS" }],
    ["第二名离第一名恰好 margin", [0.95, 0.85, 0.2], 0, { result: "CONFLICT_AMBIGUOUS" }],
    ["第二名离第一名超过 margin", [0.95, 0.8499, 0.2], 0, { result: "EXACT", index: 0 }],
    ["只有低于高置信度的候选", [0.84, 0.1], 0, { result: "CONFLICT_AMBIGUOUS" }],
    ["没有达到下限的候选", [0.49, 0.2], 0, { result: "CONFLICT_MISSING" }],
    ["没有记录", [], 0, { result: "CONFLICT_MISSING" }],
  ] as const)("%s", (_name, scores, expected, want) => {
    expect(classifyPin(scores, expected)).toMatchObject(want);
  });

  it("相似度先取 4 位小数再比较：0.84996 算作 0.85", () => {
    expect(classifyPin([0.84996], 0)).toMatchObject({ result: "EXACT", score: 0.85 });
  });

  it("margin 为 0 时并列第一仍是歧义", () => {
    expect(classifyPin([1, 1], 0, { ...T, margin: 0 }).result).toBe("CONFLICT_AMBIGUOUS");
  });

  it("相似度不是有限数时抛 RangeError", () => {
    expect(() => classifyPin([Number.NaN], 0)).toThrow(RangeError);
  });

  it("性质：应用的结果一定是唯一的最高分，并且与其余候选至少差 margin；候选按相似度降序、最多 10 个", () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 30 }), fc.nat(40), (scores, expected) => {
        const c = classifyPin(scores, expected);
        const rounded = scores.map((s) => Math.round(s * 10000) / 10000);
        const listed = rounded.filter((s) => s >= T.low);
        expect(c.candidateCount).toBe(listed.length);
        expect(c.candidates.length).toBe(Math.min(10, listed.length));
        for (let i = 1; i < c.candidates.length; i++) expect(c.candidates[i - 1]!.score).toBeGreaterThanOrEqual(c.candidates[i]!.score);
        if (c.result === "EXACT" || c.result === "RELOCATED") {
          expect(c.score).toBeGreaterThanOrEqual(T.high);
          expect(rounded.filter((s) => s >= T.high)).toHaveLength(1);
          expect(c.result === "EXACT").toBe(c.index === expected);
          rounded.forEach((s, i) => {
            if (i !== c.index) expect(Math.round((c.score - s) * 10000) / 10000).toBeGreaterThanOrEqual(T.margin);
          });
        } else if (c.result === "CONFLICT_MISSING") {
          expect(listed).toEqual([]);
        } else {
          expect(listed.length).toBeGreaterThan(0);
        }
      }),
    );
  });
});

describe("回执里的重定位选择", () => {
  const receipt = (selection: unknown, index = 3) => ({
    receiptVersion: 1,
    patchName: "p",
    patchHash: "sha256:" + "0".repeat(64),
    inputHash: "sha256:" + "1".repeat(64),
    outputHash: "sha256:" + "2".repeat(64),
    allowedProtections: [],
    entries: [{ operationId: "o", scope: "MAP01", record: "Sector", index, field: "special", oldValue: 0, newValue: 3, span: { start: 0, end: 2 }, selection, unchanged: false }],
  });

  it.each([
    [{ kind: "EXACT", expectedIndex: 3, fingerprintChecked: false }, 3],
    [{ kind: "EXACT", expectedIndex: 3, fingerprintChecked: true, score: 1 }, 3],
    [{ kind: "RELOCATED", expectedIndex: 2, fingerprintChecked: true, score: 0.9 }, 3],
  ])("接受 %j", (selection, index) => {
    const v = validateReceipt(receipt(selection, index));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.entries[0]!.selection).toEqual(selection);
  });

  it.each([
    [{ kind: "EXACT", expectedIndex: 3, fingerprintChecked: true }, 3],
    [{ kind: "EXACT", expectedIndex: 3, fingerprintChecked: false, score: 1 }, 3],
    [{ kind: "EXACT", expectedIndex: 2, fingerprintChecked: false }, 3],
    [{ kind: "RELOCATED", expectedIndex: 3, fingerprintChecked: true, score: 0.9 }, 3],
    [{ kind: "RELOCATED", expectedIndex: 2, fingerprintChecked: false }, 3],
    [{ kind: "RELOCATED", expectedIndex: 2, fingerprintChecked: true, score: 1.5 }, 3],
    [{ kind: "RELOCATED", expectedIndex: 2, fingerprintChecked: "yes", score: 1 }, 3],
    [{ kind: "MOVED", expectedIndex: 2 }, 3],
  ])("拒绝 %j", (selection, index) => {
    const v = validateReceipt(receipt(selection, index));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues.every((i) => i.code === "INVALID_RECEIPT" && i.path!.startsWith("/entries/0/selection"))).toBe(true);
  });
});
