import { describe, expect, it } from "vitest";
import { buildWad, WadFile, MAP_DATA_LUMPS } from "../src/index.ts";

const empty = new Uint8Array(0);
const d = (n: number) => new Uint8Array(n);

describe("Lump 目录与标记", () => {
  it("零字节 Lump 是标记，filepos 可以是任意值", () => {
    const b = buildWad({
      kind: "IWAD",
      lumps: [
        { name: "F_START", data: empty, markerFilepos: 4321 },
        { name: "FLAT1", data: d(4) },
        { name: "F_END", data: empty, markerFilepos: 0 },
      ],
    });
    const wad = WadFile.parse(b);
    expect(wad.kind).toBe("IWAD");
    expect(wad.lumps.map((l) => [l.name, l.isMarker, l.filepos])).toEqual([
      ["F_START", true, 4321],
      ["FLAT1", false, 12],
      ["F_END", true, 0],
    ]);
    expect(wad.lumps[0]!.dataSpan).toBeNull();
    expect(wad.regions.gaps).toEqual([]);
  });

  it("名称到第一个 NUL 为止，NUL 之后的杂字节保留在原始名称里", () => {
    const nameBytes = Uint8Array.from([0x41, 0x42, 0, 0x7f, 0xff, 1, 2, 3]);
    const b = buildWad({ kind: "PWAD", lumps: [{ name: "", nameBytes, data: d(1) }] });
    const wad = WadFile.parse(b);
    expect(wad.lumps[0]!.name).toBe("AB");
    const s = wad.lumps[0]!.nameSpan;
    expect([...b.slice(s.start, s.end)]).toEqual([...nameBytes]);
  });

  it("间隙字节被识别且不属于任何 Lump", () => {
    const b = buildWad({
      kind: "PWAD",
      lumps: [{ name: "A", data: d(4), gapBefore: d(3) }, { name: "B", data: d(2) }],
      gapBeforeDirectory: d(5),
      trailing: d(7),
    });
    const wad = WadFile.parse(b);
    expect(wad.regions.gaps).toEqual([
      { start: 12, end: 15 },
      { start: 21, end: 26 },
      { start: b.length - 7, end: b.length },
    ]);
  });

  it("空目录的 WAD 可以解析", () => {
    const wad = WadFile.parse(buildWad({ kind: "PWAD", lumps: [] }));
    expect(wad.lumps).toEqual([]);
    expect(wad.regions.directory).toBeNull();
  });
});

describe("地图作用域", () => {
  const dataLumps = MAP_DATA_LUMPS.map((name) => ({ name, data: d(2) }));

  it("标记加其后的全部数据 Lump 构成一张地图", () => {
    const wad = WadFile.parse(
      buildWad({
        kind: "PWAD",
        lumps: [{ name: "PLAYPAL", data: d(3) }, { name: "MAP01", data: empty }, ...dataLumps, { name: "MAP02", data: empty }, ...dataLumps.slice(0, 3), { name: "DEMO1", data: d(1) }],
      }),
    );
    expect(wad.maps.map((m) => [m.name, m.markerIndex, m.dataIndices.length])).toEqual([
      ["MAP01", 1, 10],
      ["MAP02", 12, 3],
    ]);
    expect(wad.mapLump(wad.findMap("map01")!, "sectors")!.name).toBe("SECTORS");
    expect(wad.mapLump(wad.findMap("MAP02")!, "SECTORS")).toBeUndefined();
  });

  it("没有数据 Lump 跟随的同名 Lump 不是地图", () => {
    const wad = WadFile.parse(buildWad({ kind: "IWAD", lumps: [{ name: "MAP01", data: d(5) }, { name: "TEXTURE1", data: d(1) }] }));
    expect(wad.maps).toEqual([]);
  });

  it("重复的数据 Lump 名称结束当前地图的作用域", () => {
    const wad = WadFile.parse(
      buildWad({ kind: "PWAD", lumps: [{ name: "E1M1", data: empty }, { name: "THINGS", data: d(1) }, { name: "THINGS", data: d(1) }] }),
    );
    expect(wad.maps[0]!.dataIndices).toEqual([1]);
  });

  it("支持 ExMy 和 MAPxx 两种命名", () => {
    const wad = WadFile.parse(
      buildWad({ kind: "IWAD", lumps: [{ name: "E2M5", data: empty }, { name: "THINGS", data: d(1) }, { name: "MAP31", data: empty }, { name: "THINGS", data: d(1) }] }),
    );
    expect(wad.maps.map((m) => m.name)).toEqual(["E2M5", "MAP31"]);
  });
});
