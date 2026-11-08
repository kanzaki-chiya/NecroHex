import type { Span } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WadFile } from "../src/index.ts";
import { fieldWrite, mapWad } from "./arbitraries.ts";
import { applyWrite, changedIndices, equalBytes, fieldRange, insideAny, readField, summarize } from "./helpers.ts";

const nameFields = fieldWrite("Sector", ["name8"]);

/** 名称按 NUL 填充到 8 字节。 */
function padded(name: string): number[] {
  const out = new Array<number>(8).fill(0);
  for (let i = 0; i < name.length; i++) out[i] = name.charCodeAt(i);
  return out;
}

describe("name8 字段写入（Sector.floorpic / ceilingpic）", () => {
  it("合法名称：读回新值，8 字节整体重写，字节只在返回的区间内变化，重新解析后结构与记录相等", () => {
    const lengths = new Set<number>();
    fc.assert(
      fc.property(mapWad, fc.array(fc.tuple(fc.nat(5), nameFields), { minLength: 1, maxLength: 10 }), ({ bytes: b, sectorCount }, edits) => {
        const wad = WadFile.parse(b);
        const sectors = wad.mapLump(wad.maps[0]!, "SECTORS")!;
        const written: Span[] = [];
        for (const [i, w] of edits) {
          const index = i % sectorCount;
          const name = w.value as string;
          lengths.add(name.length);
          // 每次写入都被接受：mapWad 的 SECTORS 在作用域内且不与别处重叠
          const s = applyWrite(wad, sectors.index, index, w);
          expect(s).toEqual(fieldRange(wad, sectors.index, index, w));
          expect(s.end - s.start).toBe(8);
          written.push(s);
          expect(readField(wad, sectors.index, index, w)).toBe(name);
          // 字段原有的 8 字节（含 NUL 之后的杂字节）被整体重写为"名称 + NUL 填充"
          expect([...wad.serialize().slice(s.start, s.end)]).toEqual(padded(name));
        }
        // I-3：其余字节不变
        const out = wad.serialize();
        expect(out.length).toBe(b.length);
        for (const idx of changedIndices(b, out)) {
          expect(insideAny(idx, written)).toBe(true);
          expect(insideAny(idx, wad.regions.gaps)).toBe(false);
        }
        expect(equalBytes(wad.original(), b)).toBe(true);
        // I-2：重新解析后相等
        const again = WadFile.parse(out);
        expect(summarize(again)).toEqual(summarize(wad));
        expect(again.readRecords(sectors.index, "Sector")).toEqual(wad.readRecords(sectors.index, "Sector"));
      }),
      { numRuns: 200 },
    );
    // 长度边界都被命中
    expect(lengths.has(1)).toBe(true);
    expect(lengths.has(8)).toBe(true);
  });

  it("两个 name8 字段都被覆盖", () => {
    const names = new Set<string>();
    fc.assert(
      fc.property(nameFields, (w) => {
        names.add(w.field);
        expect(typeof w.value).toBe("string");
      }),
      { numRuns: 100 },
    );
    expect([...names].sort()).toEqual(["ceilingpic", "floorpic"]);
  });

  // 非法名称：非字符串；长度为 0 或大于 8；含空格、NUL、0x7f 或非 Latin 字符
  const badChar = fc.constantFrom(" ", "\u0000", "\u007f", "\u0020", "\u00e9", "\u4e2d", "\u{1f600}", "\n", "\u0080");
  const invalidName: fc.Arbitrary<{ value: unknown; error: typeof TypeError | typeof RangeError }> = fc.oneof(
    fc
      .oneof(fc.integer(), fc.double(), fc.constant(null), fc.constant(undefined), fc.boolean(), fc.array(fc.string()), fc.constant({}))
      .map((value) => ({ value, error: TypeError })),
    fc.constant({ value: "", error: RangeError }),
    fc.string({ minLength: 9, maxLength: 20, unit: fc.constantFrom(..."ABCXYZ09_") }).map((value) => ({ value, error: RangeError })),
    fc
      .tuple(fc.string({ maxLength: 3, unit: fc.constantFrom(..."ABC123") }), badChar, fc.string({ maxLength: 3, unit: fc.constantFrom(..."XYZ789") }))
      .map(([a, c, z]) => ({ value: a + c + z, error: RangeError })),
  );

  it("非法名称被拒绝：抛 TypeError 或 RangeError，dirtySpans() 与 serialize() 不变", () => {
    fc.assert(
      fc.property(mapWad, fc.nat(5), nameFields, invalidName, ({ bytes: b, sectorCount }, i, w, bad) => {
        const wad = WadFile.parse(b);
        const sectors = wad.mapLump(wad.maps[0]!, "SECTORS")!;
        // 先做一次合法写入，让"不变"断言面对的是非空的脏区间
        applyWrite(wad, sectors.index, 0, { ...w, value: "GOOD" });
        const dirtyBefore = wad.dirtySpans();
        const outBefore = wad.serialize();
        let thrown: unknown;
        try {
          applyWrite(wad, sectors.index, i % sectorCount, { ...w, value: bad.value as string });
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(bad.error);
        expect(wad.dirtySpans()).toEqual(dirtyBefore);
        expect(equalBytes(wad.serialize(), outBefore)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
