import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bytesHash } from "@necrohex/core";

// 偏向填充边界：55/56 字节决定长度字段是否放得下，63/64、119/120、127/128 是块边界
const length = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(55, 56, 63, 64, 119, 120, 127, 128) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 300 }) },
);
const data = length.chain((n) => fc.uint8Array({ minLength: n, maxLength: n }));

describe("Feature: patch-engine, Property 16: SHA-256 与参考实现一致", () => {
  it("bytesHash 的十六进制部分等于 node:crypto 的结果", () => {
    fc.assert(
      fc.property(data, (bytes) => {
        const want = createHash("sha256").update(bytes).digest("hex");
        expect(bytesHash(bytes)).toBe("sha256:" + want);
      }),
      { numRuns: 500 },
    );
  });
});
