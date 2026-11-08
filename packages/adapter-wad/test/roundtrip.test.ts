import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildWad, WadFile, WadParseError } from "../src/index.ts";
import { mapWad, wadBytes } from "./arbitraries.ts";
import { changedIndices, equalBytes, insideAny, summarize } from "./helpers.ts";

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

  it("serialize 返回副本，不暴露基础缓冲", () => {
    const b = buildWad({ kind: "PWAD", lumps: [{ name: "A", data: Uint8Array.of(1, 2, 3) }] });
    const wad = WadFile.parse(b);
    const out = wad.serialize();
    out[13] = 99;
    expect(equalBytes(wad.serialize(), b)).toBe(true);
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

describe("I-2 结构对偶", () => {
  it("parse(serialize(A)) 等于 A，包含写入之后", () => {
    fc.assert(
      fc.property(mapWad, fc.array(fc.tuple(fc.nat(5), fc.integer({ min: -32768, max: 32767 })), { maxLength: 8 }), ({ bytes: b, sectorCount }, edits) => {
        const a = WadFile.parse(b);
        const map = a.maps[0]!;
        const sectors = a.mapLump(map, "SECTORS")!;
        for (const [i, v] of edits) a.setField(sectors.index, "Sector", i % sectorCount, "lightlevel", v);
        const again = WadFile.parse(a.serialize());
        expect(summarize(again)).toEqual(summarize(a));
        expect(again.readRecords(sectors.index, "Sector")).toEqual(a.readRecords(sectors.index, "Sector"));
      }),
      { numRuns: 200 },
    );
  });
});

describe("局部性", () => {
  it("写入只改变被写字段的区间，其余字节包括间隙都不变", () => {
    fc.assert(
      fc.property(
        mapWad,
        fc.array(fc.tuple(fc.nat(5), fc.integer({ min: -32768, max: 32767 }), fc.integer({ min: -32768, max: 32767 })), { maxLength: 8 }),
        ({ bytes: b, sectorCount }, edits) => {
          const wad = WadFile.parse(b);
          const sectors = wad.mapLump(wad.maps[0]!, "SECTORS")!;
          const written = edits.flatMap(([i, light, special]) => [
            wad.setField(sectors.index, "Sector", i % sectorCount, "lightlevel", light),
            wad.setField(sectors.index, "Sector", i % sectorCount, "special", special),
          ]);
          const out = wad.serialize();
          expect(out.length).toBe(b.length);
          for (const idx of changedIndices(b, out)) expect(insideAny(idx, written)).toBe(true);
          for (const idx of changedIndices(b, out)) expect(insideAny(idx, wad.regions.gaps)).toBe(false);
          expect(equalBytes(wad.baseBuffer, b)).toBe(true);
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
