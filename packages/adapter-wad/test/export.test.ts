import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildWad, exportFullWad, exportPwad, MAP_DATA_LUMPS, WadExportError, WadFile, type LumpInput } from "../src/index.ts";
import { fieldWrite, mapWad } from "./arbitraries.ts";
import { applyWrite, changedIndices, equalBytes, insideAny, withFilepos } from "./helpers.ts";

const write = fc.record({
  w: fc.oneof(fieldWrite("Sector"), fieldWrite("Thing")),
  index: fc.nat(),
});

function codeOf(call: () => unknown): string | undefined {
  try {
    call();
  } catch (e) {
    return e instanceof WadExportError ? e.code : `OTHER: ${String(e)}`;
  }
  return undefined;
}

/** 标记 + 全部 10 个数据 Lump；SECTORS 有 count 条全零记录。 */
function mapLumps(name: string, sectors = 2, extra: LumpInput[] = []): LumpInput[] {
  return [
    { name, data: new Uint8Array(0) },
    ...MAP_DATA_LUMPS.map((n) => ({ name: n, data: n === "SECTORS" ? new Uint8Array(26 * sectors) : Uint8Array.of(1, 2, 3, 4) })),
    ...extra,
  ];
}

function sectorsOf(wad: WadFile, map: string): number {
  const m = wad.maps.find((s) => s.name === map)!;
  return m.lumps["SECTORS"]!;
}

describe("PWAD 导出", () => {
  it("修改过的地图带着标记和作用域内全部数据 Lump 导出，名称字节和数据与源文件当前字节相同", () => {
    fc.assert(
      fc.property(mapWad, fc.array(write, { minLength: 1, maxLength: 8 }), ({ bytes, sectorCount, thingCount }, writes) => {
        const wad = WadFile.parse(bytes);
        const map = wad.maps[0]!;
        for (const { w, index } of writes) {
          const lump = map.lumps[w.record === "Sector" ? "SECTORS" : "THINGS"]!;
          applyWrite(wad, lump, index % (w.record === "Sector" ? sectorCount : thingCount), w);
        }
        const out = exportPwad(wad);
        const pwad = WadFile.parse(out.bytes);
        const current = wad.serialize();
        const srcIndices = [map.markerIndex, ...map.dataIndices];

        expect(pwad.kind).toBe("PWAD");
        expect(pwad.maps.map((m) => [m.name, m.format])).toEqual([[map.name, map.format]]);
        expect(pwad.lumps.length).toBe(srcIndices.length);
        expect(out.maps).toEqual([{ name: map.name, lumps: srcIndices.map((i) => wad.lumps[i]!.name), modified: true }]);
        const raw = pwad.original();
        srcIndices.forEach((src, i) => {
          const s = wad.lumps[src]!;
          const o = pwad.lumps[i]!;
          expect(equalBytes(raw.subarray(o.nameSpan.start, o.nameSpan.end), current.subarray(s.nameSpan.start, s.nameSpan.end))).toBe(true);
          expect(equalBytes(pwad.lumpBytes(i), wad.lumpBytes(src))).toBe(true);
        });
        // 导出结果在数据 Lump 上是完整的：每个标准数据 Lump 都在
        expect(Object.keys(pwad.maps[0]!.lumps).sort()).toEqual([...MAP_DATA_LUMPS].sort());
        // 导出的 PWAD 本身无改动往返
        expect(equalBytes(pwad.serialize(), out.bytes)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("没有修改且没有指定地图时拒绝；显式指定时导出未修改的地图", () => {
    fc.assert(
      fc.property(mapWad, ({ bytes }) => {
        const wad = WadFile.parse(bytes);
        expect(codeOf(() => exportPwad(wad))).toBe("NOTHING_TO_EXPORT");
        const name = wad.maps[0]!.name;
        const out = exportPwad(wad, { maps: [name.toLowerCase()] });
        expect(out.maps[0]!.modified).toBe(false);
        const pwad = WadFile.parse(out.bytes);
        const src = [wad.maps[0]!.markerIndex, ...wad.maps[0]!.dataIndices];
        src.forEach((s, i) => expect(equalBytes(pwad.lumpBytes(i), wad.lumpBytes(s))).toBe(true));
      }),
      { numRuns: 100 },
    );
  });

  it("只导出含修改的地图，地图之外的 Lump 不进入 PWAD", () => {
    const bytes = buildWad({
      kind: "IWAD",
      lumps: [{ name: "PLAYPAL", data: new Uint8Array(30) }, ...mapLumps("MAP01"), ...mapLumps("MAP02"), { name: "ENDOOM", data: new Uint8Array(8) }],
    });
    const wad = WadFile.parse(bytes);
    wad.setField(sectorsOf(wad, "MAP02"), "Sector", 1, "lightlevel", 64);
    const out = exportPwad(wad);
    const pwad = WadFile.parse(out.bytes);
    expect(pwad.lumps.map((l) => l.name)).toEqual(["MAP02", ...MAP_DATA_LUMPS]);
    expect(pwad.readRecord(pwad.maps[0]!.lumps["SECTORS"]!, "Sector", 1).lightlevel).toBe(64);
  });

  it("修改落在未导出的地图里时拒绝，不静默丢掉修改", () => {
    const wad = WadFile.parse(buildWad({ kind: "PWAD", lumps: [...mapLumps("MAP01"), ...mapLumps("MAP02")] }));
    wad.setField(sectorsOf(wad, "MAP02"), "Sector", 0, "lightlevel", 64);
    expect(codeOf(() => exportPwad(wad, { maps: ["MAP01"] }))).toBe("CHANGES_OUTSIDE_EXPORT");
    expect(exportPwad(wad, { maps: ["MAP01", "MAP02"] }).maps.map((m) => [m.name, m.modified])).toEqual([
      ["MAP01", false],
      ["MAP02", true],
    ]);
  });

  it("地图名不存在或重名时拒绝，不猜测", () => {
    const wad = WadFile.parse(buildWad({ kind: "PWAD", lumps: [...mapLumps("MAP01"), ...mapLumps("MAP01")] }));
    expect(codeOf(() => exportPwad(wad, { maps: ["MAP07"] }))).toBe("MAP_NOT_FOUND");
    expect(codeOf(() => exportPwad(wad, { maps: ["map01"] }))).toBe("AMBIGUOUS_MAP");
    wad.setField(wad.maps[0]!.lumps["SECTORS"]!, "Sector", 0, "lightlevel", 1);
    wad.setField(wad.maps[1]!.lumps["SECTORS"]!, "Sector", 0, "lightlevel", 1);
    expect(codeOf(() => exportPwad(wad))).toBe("AMBIGUOUS_MAP");
  });

  it("导出地图的 Lump 数据不在文件内时拒绝，不写出空 Lump", () => {
    const bytes = buildWad({ kind: "PWAD", lumps: mapLumps("MAP01") });
    const reject = WadFile.parse(bytes).maps[0]!.lumps["REJECT"]!;
    const broken = withFilepos(bytes, reject, bytes.length + 100);
    const wad = WadFile.parse(broken);
    expect(wad.lumps[reject]!.issues).toEqual(["DATA_OUT_OF_BOUNDS"]);
    wad.setField(wad.maps[0]!.lumps["SECTORS"]!, "Sector", 0, "lightlevel", 1);
    expect(codeOf(() => exportPwad(wad))).toBe("UNREADABLE_LUMP");
  });

  it("Hexen 地图显式导出时带上 BEHAVIOR，原样复制", () => {
    const behavior = Uint8Array.of(0x41, 0x43, 0x53, 0, 9, 9);
    const wad = WadFile.parse(buildWad({ kind: "PWAD", lumps: mapLumps("MAP01", 1, [{ name: "BEHAVIOR", data: behavior }]) }));
    const pwad = WadFile.parse(exportPwad(wad, { maps: ["MAP01"] }).bytes);
    expect(pwad.maps[0]!.format).toBe("hexen");
    expect(equalBytes(pwad.lumpBytes(pwad.maps[0]!.lumps["BEHAVIOR"]!), behavior)).toBe(true);
  });
});

describe("完整 WAD 导出", () => {
  it("与源文件等长，字节只在写入的区间变化", () => {
    fc.assert(
      fc.property(mapWad, fc.array(write, { maxLength: 8 }), ({ bytes, sectorCount, thingCount }, writes) => {
        const wad = WadFile.parse(bytes);
        const map = wad.maps[0]!;
        const spans = writes.map(({ w, index }) =>
          applyWrite(wad, map.lumps[w.record === "Sector" ? "SECTORS" : "THINGS"]!, index % (w.record === "Sector" ? sectorCount : thingCount), w),
        );
        const out = exportFullWad(wad);
        expect(out.bytes.length).toBe(bytes.length);
        for (const i of changedIndices(bytes, out.bytes)) expect(insideAny(i, spans)).toBe(true);
        expect(out.changed).toEqual(wad.dirtySpans());
      }),
      { numRuns: 200 },
    );
  });
});

describe("Freedoom 夹具导出", () => {
  const fixture = new Uint8Array(readFileSync(resolve(import.meta.dirname, "../fixtures/freedoom/freedoom2-map01-02.wad")));

  it("改 MAP01 的扇区亮度后导出 PWAD：只含 MAP01 的标记和 10 个数据 Lump，未改动的 Lump 与夹具逐字节相同", () => {
    const wad = WadFile.parse(fixture);
    const map = wad.findMap("MAP01")!;
    const sectors = map.lumps["SECTORS"]!;
    const before = wad.readRecords(sectors, "Sector");
    before.forEach((s, i) => {
      if (s.lightlevel >= 160) wad.setField(sectors, "Sector", i, "lightlevel", s.lightlevel >> 1);
    });
    const out = exportPwad(wad);
    const pwad = WadFile.parse(out.bytes);
    expect(pwad.lumps.map((l) => l.name)).toEqual(["MAP01", ...MAP_DATA_LUMPS]);
    const src = WadFile.parse(fixture);
    for (const [name, i] of Object.entries(pwad.maps[0]!.lumps)) {
      const same = equalBytes(pwad.lumpBytes(i), src.lumpBytes(map.lumps[name]!));
      expect(same).toBe(name !== "SECTORS");
    }
    const after = pwad.readRecords(pwad.maps[0]!.lumps["SECTORS"]!, "Sector");
    after.forEach((s, i) => {
      const b = before[i]!;
      expect(s).toEqual({ ...b, lightlevel: b.lightlevel >= 160 ? b.lightlevel >> 1 : b.lightlevel });
    });
  });
});
