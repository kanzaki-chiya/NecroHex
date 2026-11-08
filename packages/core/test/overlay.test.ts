import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ByteOverlay, complementSpans, mergeSpans } from "../src/index.ts";

describe("ByteOverlay", () => {
  it("materialize 只改变写入的区间，基础缓冲不变", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        fc.array(fc.tuple(fc.nat(63), fc.uint8Array({ minLength: 1, maxLength: 8 })), { maxLength: 6 }),
        (base, writes) => {
          const frozen = base.slice();
          const o = new ByteOverlay(base);
          const spans = [];
          for (const [at, bytes] of writes) {
            if (at + bytes.length > base.length) continue;
            spans.push(o.write(at, bytes));
          }
          const out = o.materialize();
          expect(base).toEqual(frozen);
          for (let i = 0; i < base.length; i++) {
            if (out[i] !== base[i]) expect(spans.some((s) => i >= s.start && i < s.end)).toBe(true);
          }
          expect(o.read(0, base.length)).toEqual(out);
        },
      ),
    );
  });

  it("越界写入被拒绝", () => {
    const o = new ByteOverlay(new Uint8Array(4));
    expect(() => o.write(3, Uint8Array.of(1, 2))).toThrow(RangeError);
    expect(() => o.write(-1, Uint8Array.of(1))).toThrow(RangeError);
    expect(o.dirty).toBe(false);
  });
});

describe("span", () => {
  it("mergeSpans 与 complementSpans 互补", () => {
    expect(mergeSpans([{ start: 5, end: 8 }, { start: 0, end: 2 }, { start: 2, end: 3 }, { start: 7, end: 9 }])).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 9 },
    ]);
    expect(complementSpans(12, [{ start: 0, end: 3 }, { start: 5, end: 9 }])).toEqual([
      { start: 3, end: 5 },
      { start: 9, end: 12 },
    ]);
  });
});
