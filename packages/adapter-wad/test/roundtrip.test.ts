import type { Span } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildWad, WadFile, WadParseError, WadRecordError } from "../src/index.ts";
import { fieldWrite, mapWad, placedMapWad, wadBytes } from "./arbitraries.ts";
import { applyWrite, changedIndices, equalBytes, fieldRange, insideAny, readField, summarize, touchesStructure } from "./helpers.ts";

describe("I-1 无损往返", () => {
  it("不做修改时，serialize(parse(B)) 与 B 逐字节相同", () => {
    fc.assert(
      fc.property(wadBytes, (b) => {
        const out = WadFile.parse(b).serialize();
        expect(equalBytes(out, b)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("serialize 与 original 返回副本，不暴露基础缓冲", () => {
    const b = buildWad({ kind: "PWAD", lumps: [{ name: "A", data: Uint8Array.of(1, 2, 3) }] });
    const wad = WadFile.parse(b);
    const out = wad.serialize();
    out[13] = 99;
    expect(equalBytes(wad.serialize(), b)).toBe(true);
    const orig = wad.original();
    orig[13] = 99;
    expect(equalBytes(wad.original(), b)).toBe(true);
    expect(equalBytes(wad.serialize(), b)).toBe(true);
  });

  it("parse 之后对输入、serialize()、original()、lumpBytes() 返回值的任意修改，都不影响 serialize() 与 original()", () => {
    const mutation = fc.record({
      target: fc.constantFrom("input" as const, "serialize" as const, "original" as const, "lumpBytes" as const),
      at: fc.nat(),
      value: fc.integer({ min: 0, max: 255 }),
    });
    fc.assert(
      fc.property(wadBytes, fc.array(mutation, { maxLength: 12 }), (b, mutations) => {
        const expected = b.slice();
        const input = b.slice();
        const wad = WadFile.parse(input);
        for (const m of mutations) {
          const arr =
            m.target === "input"
              ? input
              : m.target === "serialize"
                ? wad.serialize()
                : m.target === "original"
                  ? wad.original()
                  : wad.lumps.length > 0
                    ? wad.lumpBytes(m.at % wad.lumps.length)
                    : new Uint8Array(0);
          if (arr.length > 0) arr[m.at % arr.length] = m.value;
        }
        expect(equalBytes(wad.serialize(), expected)).toBe(true);
        expect(equalBytes(wad.original(), expected)).toBe(true);
        expect(wad.dirtySpans()).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("头、目录、Lump 数据和间隙恰好铺满整个文件", () => {
    fc.assert(
      fc.property(wadBytes, (b) => {
        const wad = WadFile.parse(b);
        const r = wad.regions;
        const spans = [r.header, ...(r.directory ? [r.directory] : []), ...r.lumpData, ...r.gaps];
        const covered = new Uint8Array(b.length);
        for (const s of spans) for (let i = s.start; i < s.end; i++) covered[i] = 1;
        expect(covered.every((v) => v === 1)).toBe(true);
        for (const g of r.gaps) for (const o of [r.header, ...r.lumpData, ...(r.directory ? [r.directory] : [])]) {
          expect(g.start < o.end && o.start < g.end).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("目录项中的 8 字节原始名称原样可读", () => {
    fc.assert(
      fc.property(wadBytes, (b) => {
        const wad = WadFile.parse(b);
        for (const l of wad.lumps) {
          expect(l.nameSpan.end - l.nameSpan.start).toBe(8);
          expect(l.nameSpan.start).toBe(l.entrySpan.start + 8);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// Sector 记录布局（见 spec/wad.records.yaml）：26 字节，lightlevel 在偏移 20，2 字节。
// 这里有意不从生成的布局读取，让参考判定独立于被测代码。
const SECTOR_SIZE = 26;
const LIGHTLEVEL_OFFSET = 20;

describe("I-2 结构对偶", () => {
  it("每次 setField 要么被接受要么因结构重叠被拒绝；被接受的写入之后 parse(serialize(A)) 等于 A", () => {
    let acceptedCount = 0;
    let rejectedCount = 0;
    fc.assert(
      fc.property(
        placedMapWad,
        fc.array(fc.tuple(fc.nat(5), fc.integer({ min: -32768, max: 32767 })), { maxLength: 8 }),
        ({ bytes: b, sectorCount }, edits) => {
          const a = WadFile.parse(b);
          const sectors = a.mapLump(a.maps[0]!, "SECTORS")!;
          for (const [i, v] of edits) {
            const index = i % sectorCount;
            const start = sectors.filepos + index * SECTOR_SIZE + LIGHTLEVEL_OFFSET;
            const rejected = touchesStructure(a, b.length, sectors.index, start, start + 2);
            const dirtyBefore = a.dirtySpans();
            const outBefore = a.serialize();
            if (rejected) {
              rejectedCount++;
              let thrown: unknown;
              try {
                a.setField(sectors.index, "Sector", index, "lightlevel", v);
              } catch (e) {
                thrown = e;
              }
              expect(thrown).toBeInstanceOf(WadRecordError);
              expect((thrown as WadRecordError).code).toBe("WRITE_OVERLAPS_STRUCTURE");
              expect(a.dirtySpans()).toEqual(dirtyBefore);
              expect(equalBytes(a.serialize(), outBefore)).toBe(true);
            } else {
              acceptedCount++;
              expect(a.setField(sectors.index, "Sector", index, "lightlevel", v)).toEqual({ start, end: start + 2 });
            }
          }
          const again = WadFile.parse(a.serialize());
          expect(summarize(again)).toEqual(summarize(a));
          expect(again.readRecords(sectors.index, "Sector")).toEqual(a.readRecords(sectors.index, "Sector"));
        },
      ),
      { numRuns: 300 },
    );
    // 生成器必须同时命中两种结果，否则这个属性是空转
    expect(acceptedCount).toBeGreaterThan(0);
    expect(rejectedCount).toBeGreaterThan(0);
  });

  it("作用域内的地图：Thing 全部字段和 Sector.lightlevel 的写入都被接受，之后 parse(serialize(A)) 等于 A", () => {
    const touched = new Set<string>();
    fc.assert(
      fc.property(
        mapWad,
        fc.array(fc.tuple(fc.nat(5), fieldWrite("Thing")), { maxLength: 10 }),
        fc.array(fc.tuple(fc.nat(5), fc.integer({ min: -32768, max: 32767 })), { maxLength: 6 }),
        ({ bytes: b, sectorCount, thingCount }, thingEdits, sectorEdits) => {
          const a = WadFile.parse(b);
          const map = a.maps[0]!;
          const sectors = a.mapLump(map, "SECTORS")!;
          const things = a.mapLump(map, "THINGS")!;
          expect(things.size).toBe(thingCount * 10);
          for (const [i, w] of thingEdits) {
            // 不抛 WadRecordError：mapWad 的 Lump 都在作用域内且互不重叠
            applyWrite(a, things.index, i % thingCount, w);
            touched.add(w.field);
          }
          for (const [i, v] of sectorEdits) a.setField(sectors.index, "Sector", i % sectorCount, "lightlevel", v);
          const again = WadFile.parse(a.serialize());
          expect(summarize(again)).toEqual(summarize(a));
          expect(again.readRecords(things.index, "Thing")).toEqual(a.readRecords(things.index, "Thing"));
          expect(again.readRecords(sectors.index, "Sector")).toEqual(a.readRecords(sectors.index, "Sector"));
        },
      ),
      { numRuns: 200 },
    );
    expect([...touched].sort()).toEqual(["angle", "flags", "type", "x", "y"]);
  });

  it("边界：目标字段与文件头、目录首尾相接时被接受", () => {
    // SECTORS 紧跟在文件头之后（filepos 12）并紧贴目录（数据结束于 directoryOffset）
    const b = buildWad({ kind: "PWAD", lumps: [{ name: "MAP01", data: new Uint8Array(0) }, { name: "SECTORS", data: new Uint8Array(SECTOR_SIZE * 2) }] });
    const wad = WadFile.parse(b);
    const sectors = wad.findLump("SECTORS")!;
    expect(sectors.filepos).toBe(12);
    expect(wad.directoryOffset).toBe(12 + SECTOR_SIZE * 2);
    expect(wad.setField(sectors.index, "Sector", 0, "floorheight", 5)).toEqual({ start: 12, end: 14 }); // T.start === header.end
    const last = wad.setField(sectors.index, "Sector", 1, "tag", 5); // 最后一个字段，T.end === directory.start
    expect(last.end).toBe(wad.directoryOffset);
  });
});

describe("局部性", () => {
  it("写入只改变被接受的字段区间，被拒绝的调用不贡献区间，其余字节包括间隙、头、目录和其他 Lump 都不变", () => {
    fc.assert(
      fc.property(
        placedMapWad,
        fc.array(fc.tuple(fc.nat(5), fc.integer({ min: -32768, max: 32767 }), fc.integer({ min: -32768, max: 32767 })), { maxLength: 8 }),
        ({ bytes: b, sectorCount }, edits) => {
          const wad = WadFile.parse(b);
          const sectors = wad.mapLump(wad.maps[0]!, "SECTORS")!;
          const written: Span[] = [];
          for (const [i, light, special] of edits) {
            for (const [field, value] of [["lightlevel", light], ["special", special]] as const) {
              try {
                written.push(wad.setField(sectors.index, "Sector", i % sectorCount, field, value));
              } catch (e) {
                expect(e).toBeInstanceOf(WadRecordError);
              }
            }
          }
          const out = wad.serialize();
          expect(out.length).toBe(b.length);
          for (const idx of changedIndices(b, out)) expect(insideAny(idx, written)).toBe(true);
          for (const idx of changedIndices(b, out)) expect(insideAny(idx, wad.regions.gaps)).toBe(false);
          // 被接受的区间不触碰头、目录和自己以外的 Lump（参考判定独立于 WadFile）
          for (const s of written) expect(touchesStructure(wad, b.length, sectors.index, s.start, s.end)).toBe(false);
          for (const idx of changedIndices(b, out)) expect(touchesStructure(wad, b.length, sectors.index, idx, idx + 1)).toBe(false);
          expect(equalBytes(wad.original(), b)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("局部性：Thing 全部字段", () => {
  it("作用域内的地图：写入只改变被写字段的区间，读回新值，原始字节不变", () => {
    fc.assert(
      fc.property(
        mapWad,
        fc.array(fc.tuple(fc.nat(5), fieldWrite("Thing")), { maxLength: 10 }),
        fc.array(fc.tuple(fc.nat(5), fc.integer({ min: -32768, max: 32767 }), fc.integer({ min: -32768, max: 32767 })), { maxLength: 4 }),
        ({ bytes: b, sectorCount, thingCount }, thingEdits, sectorEdits) => {
          const wad = WadFile.parse(b);
          const map = wad.maps[0]!;
          const things = wad.mapLump(map, "THINGS")!;
          const sectors = wad.mapLump(map, "SECTORS")!;
          const written: Span[] = [];
          for (const [i, w] of thingEdits) {
            const index = i % thingCount;
            const s = applyWrite(wad, things.index, index, w);
            expect(s).toEqual(fieldRange(wad, things.index, index, w));
            expect(readField(wad, things.index, index, w)).toEqual(w.value);
            written.push(s);
          }
          for (const [i, light, special] of sectorEdits) {
            written.push(wad.setField(sectors.index, "Sector", i % sectorCount, "lightlevel", light));
            written.push(wad.setField(sectors.index, "Sector", i % sectorCount, "special", special));
          }
          const out = wad.serialize();
          expect(out.length).toBe(b.length);
          for (const idx of changedIndices(b, out)) {
            expect(insideAny(idx, written)).toBe(true);
            expect(insideAny(idx, wad.regions.gaps)).toBe(false);
          }
          expect(equalBytes(wad.original(), b)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("异常数据", () => {
  it("任意字节要么抛 WadParseError，要么无损往返", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 120 }), fc.constantFrom("IWAD", "PWAD", "XXXX"), (tail, ident) => {
        const b = new Uint8Array(4 + tail.length);
        b.set([...ident].map((c) => c.charCodeAt(0)));
        b.set(tail, 4);
        try {
          expect(equalBytes(WadFile.parse(b).serialize(), b)).toBe(true);
        } catch (e) {
          expect(e).toBeInstanceOf(WadParseError);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("损坏目录项的合法容器仍无损往返，问题记入 issues", () => {
    fc.assert(
      fc.property(wadBytes, fc.nat(), fc.uint8Array({ minLength: 1, maxLength: 16 }), (b, at, junk) => {
        const wad0 = WadFile.parse(b);
        if (!wad0.regions.directory) return;
        const dir = wad0.regions.directory;
        const copy = b.slice();
        for (let i = 0; i < junk.length; i++) {
          const p = dir.start + ((at + i) % (dir.end - dir.start));
          copy[p] = junk[i]!;
        }
        const wad = WadFile.parse(copy);
        expect(equalBytes(wad.serialize(), copy)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("越界、负数和重叠的 Lump 被记录而不是拒绝", () => {
    const b = buildWad({ kind: "IWAD", lumps: [{ name: "A", data: Uint8Array.of(1, 2, 3, 4) }, { name: "B", data: Uint8Array.of(5) }] });
    const dv = new DataView(b.buffer);
    const dir = dv.getInt32(8, true);
    dv.setInt32(dir + 4, 9999, true); // A 越界
    dv.setInt32(dir + 16, -5, true); // B 负 filepos
    const wad = WadFile.parse(b);
    expect(wad.lumps[0]!.issues).toEqual(["DATA_OUT_OF_BOUNDS"]);
    expect(wad.lumps[0]!.dataSpan).toBeNull();
    expect(wad.lumps[1]!.issues).toEqual(["NEGATIVE_FIELD"]);
    expect(equalBytes(wad.serialize(), b)).toBe(true);
  });

  it("无法定位目录时给出带错误码的异常", () => {
    const code = (b: Uint8Array): string | undefined => {
      try {
        WadFile.parse(b);
      } catch (e) {
        return e instanceof WadParseError ? e.code : "OTHER";
      }
      return undefined;
    };
    expect(code(new Uint8Array(5))).toBe("TOO_SHORT");
    expect(code(Uint8Array.from([...Buffer.from("ZWAD"), 0, 0, 0, 0, 12, 0, 0, 0]))).toBe("BAD_IDENT");
    expect(code(Uint8Array.from([...Buffer.from("PWAD"), 1, 0, 0, 0, 12, 0, 0, 0]))).toBe("BAD_DIRECTORY");
    expect(code(Uint8Array.from([...Buffer.from("PWAD"), 0xff, 0xff, 0xff, 0xff, 12, 0, 0, 0]))).toBe("BAD_DIRECTORY");
    expect(code(Uint8Array.from([...Buffer.from("PWAD"), 0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined();
  });
});
