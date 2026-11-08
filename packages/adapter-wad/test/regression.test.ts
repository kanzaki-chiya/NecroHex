/**
 * 回归用例：每个由属性测试或人工核对发现的缺陷对应一个命名用例，用例名以缺陷编号开头。
 * 编号对应 .kiro/specs/wad-roundtrip/design.md 的"已知差异与风险"。
 * 已有用例（按实施顺序）：D-5、X-1、X-4、D-6、F-3、X-3。
 */
import { describe, expect, it } from "vitest";
import * as core from "@necrohex/core";
import * as coreInternal from "@necrohex/core/internal";
import { buildWad, WadFile, WadRecordError } from "../src/index.ts";
import { equalBytes, withFilepos } from "./helpers.ts";

describe("D-5 parse 复制输入，baseBuffer 不再存在", () => {
  const source = () => buildWad({ kind: "PWAD", lumps: [{ name: "A", data: Uint8Array.of(1, 2, 3, 4) }] });

  it("parse 之后修改输入数组，serialize() 与 original() 仍等于原输入", () => {
    const input = source();
    const expected = input.slice();
    const wad = WadFile.parse(input);
    input[13] = 0xee;
    input[0] = 0;
    expect(equalBytes(wad.serialize(), expected)).toBe(true);
    expect(equalBytes(wad.original(), expected)).toBe(true);
    expect(equalBytes(wad.lumpBytes(0), Uint8Array.of(1, 2, 3, 4))).toBe(true);
  });

  it("输入是 Node Buffer 时同样复制（Buffer.slice 返回视图，不能用它复制）", () => {
    const input = Buffer.from(source());
    const expected = Uint8Array.from(input);
    const wad = WadFile.parse(input);
    input[13] = 0xee;
    expect(equalBytes(wad.serialize(), expected)).toBe(true);
  });

  it("修改 serialize()、original() 的返回值不影响之后的结果", () => {
    const input = source();
    const wad = WadFile.parse(input);
    const s = wad.serialize();
    const o = wad.original();
    s[13] = 0xaa;
    o[13] = 0xbb;
    expect(equalBytes(wad.serialize(), input)).toBe(true);
    expect(equalBytes(wad.original(), input)).toBe(true);
  });

  it("WadFile 上不再有可读写的 baseBuffer", () => {
    const wad = WadFile.parse(source());
    expect("baseBuffer" in wad).toBe(false);
  });
});

describe("X-1 setField 拒绝写入头、目录或其他 Lump 的区间", () => {
  it("SECTORS 数据区间指向文件头时：parse 成功，setField 抛 WRITE_OVERLAPS_STRUCTURE，不留痕迹", () => {
    // SECTORS 在 MAP01 的地图作用域内；只改写目录项的 filepos
    const clean = buildWad({ kind: "PWAD", lumps: [{ name: "MAP01", data: new Uint8Array(0) }, { name: "SECTORS", data: new Uint8Array(26) }] });
    const input = withFilepos(clean, 1, 0);
    const w = WadFile.parse(input);
    expect(w.lumps[1]!.issues).toEqual([]);
    expect(w.lumps[1]!.dataSpan).toEqual({ start: 0, end: 26 });
    expect(w.maps[0]!.dataIndices).toEqual([1]);

    let thrown: unknown;
    try {
      w.setField(1, "Sector", 0, "floorheight", 0x4441);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(WadRecordError);
    expect((thrown as WadRecordError).code).toBe("WRITE_OVERLAPS_STRUCTURE");
    expect((thrown as WadRecordError).lumpIndex).toBe(1);
    expect(w.dirtySpans()).toEqual([]);
    expect(equalBytes(w.serialize(), input)).toBe(true);
    // 修复前这里会抛 BAD_IDENT：头部标识被改成 "ADAD"
    expect(() => WadFile.parse(w.serialize())).not.toThrow();
  });

  it("参数类错误先于结构拒绝报告", () => {
    const input = withFilepos(
      buildWad({ kind: "PWAD", lumps: [{ name: "MAP01", data: new Uint8Array(0) }, { name: "SECTORS", data: new Uint8Array(26) }] }),
      1,
      0,
    );
    const w = WadFile.parse(input);
    expect(() => w.setField(1, "Sector", 0, "floorheight", 40000)).toThrow(RangeError);
    expect(() => w.setField(1, "Sector", 3, "floorheight", 1)).toThrow(RangeError);
    expect(w.dirtySpans()).toEqual([]);
  });

  it("数据区间互相重叠的 Lump：对其中一个的重叠字段写入被拒绝，不重叠的字段允许写入", () => {
    // SECTORS 与后面的 THINGS 共享字节：把 THINGS 的 filepos 指向 SECTORS 数据的第 20 字节处
    const clean = buildWad({
      kind: "PWAD",
      lumps: [{ name: "MAP01", data: new Uint8Array(0) }, { name: "SECTORS", data: new Uint8Array(26) }, { name: "THINGS", data: new Uint8Array(10) }],
    });
    const sectorsAt = WadFile.parse(clean).lumps[1]!.filepos;
    const input = withFilepos(clean, 2, sectorsAt + 20);
    const w = WadFile.parse(input);
    expect(w.lumps[2]!.dataSpan).toEqual({ start: sectorsAt + 20, end: sectorsAt + 30 });
    expect(() => w.setField(1, "Sector", 0, "lightlevel", 1)).toThrow(WadRecordError); // [20, 22) 落在 THINGS 内
    expect(w.setField(1, "Sector", 0, "floorheight", 1)).toEqual({ start: sectorsAt, end: sectorsAt + 2 }); // 不相交的字段仍可写
  });
});

describe("X-4 不属于任何地图作用域的 Lump 可读不可写", () => {
  const empty = new Uint8Array(0);

  /** n 个扇区，第 i 个的 floorheight = i * 8，lightlevel = 100 + i，floorpic = FLATn。 */
  function sectors(n: number): Uint8Array {
    const raw = new Uint8Array(26 * n);
    const v = new DataView(raw.buffer);
    for (let i = 0; i < n; i++) {
      v.setInt16(i * 26, i * 8, true);
      v.setInt16(i * 26 + 20, 100 + i, true);
      raw.set([...Buffer.from(`FLAT${i}`)], i * 26 + 4);
    }
    return raw;
  }

  /** m 个 Thing，第 i 个的 x = i，type = 3001。 */
  function things(m: number): Uint8Array {
    const raw = new Uint8Array(10 * m);
    const v = new DataView(raw.buffer);
    for (let i = 0; i < m; i++) {
      v.setInt16(i * 10, i, true);
      v.setInt16(i * 10 + 6, 3001, true);
    }
    return raw;
  }

  function expectReadableNotWritable(wad: WadFile, input: Uint8Array, sectorsIndex: number, thingsIndex?: number): void {
    expect(wad.maps.every((m) => !m.dataIndices.includes(sectorsIndex))).toBe(true);
    // 读取不变：按 Doom 布局解释
    expect(wad.recordCount(sectorsIndex, "Sector")).toBe(Math.floor(wad.lumps[sectorsIndex]!.size / 26));
    const read = wad.readRecords(sectorsIndex, "Sector");
    expect(read).toHaveLength(2);
    expect(read[1]).toMatchObject({ floorheight: 8, lightlevel: 101, floorpic: "FLAT1" });
    expect(wad.fieldSpan(sectorsIndex, "Sector", 1, "lightlevel")).toEqual({
      start: wad.lumps[sectorsIndex]!.filepos + 26 + 20,
      end: wad.lumps[sectorsIndex]!.filepos + 26 + 22,
    });
    if (thingsIndex !== undefined) {
      expect(wad.readRecords(thingsIndex, "Thing")).toMatchObject([{ x: 0, type: 3001 }, { x: 1, type: 3001 }]);
    }
    // 写入被拒绝，不留痕迹
    const targets: Array<[number, "Sector" | "Thing"]> = [[sectorsIndex, "Sector"]];
    if (thingsIndex !== undefined) targets.push([thingsIndex, "Thing"]);
    for (const [i, rec] of targets) {
      let thrown: unknown;
      try {
        if (rec === "Sector") wad.setField(i, "Sector", 0, "lightlevel", 1);
        else wad.setField(i, "Thing", 0, "x", 1);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(WadRecordError);
      expect((thrown as WadRecordError).code).toBe("OUTSIDE_MAP_SCOPE");
      expect((thrown as WadRecordError).lumpIndex).toBe(i);
    }
    expect(wad.dirtySpans()).toEqual([]);
    expect(equalBytes(wad.serialize(), input)).toBe(true);
  }

  it("没有任何地图标记的裸 SECTORS 和 THINGS", () => {
    const input = buildWad({ kind: "PWAD", lumps: [{ name: "SECTORS", data: sectors(2) }, { name: "THINGS", data: things(2) }] });
    const wad = WadFile.parse(input);
    expect(wad.maps).toEqual([]);
    expectReadableNotWritable(wad, input, 0, 1);
  });

  it("作用域被未识别 Lump 提前截断后，落在作用域之外的 SECTORS", () => {
    const input = buildWad({
      kind: "PWAD",
      lumps: [
        { name: "MAP01", data: empty },
        { name: "THINGS", data: things(2) },
        { name: "LINEDEFS", data: new Uint8Array(14) },
        { name: "XUNKNOWN", data: new Uint8Array(3) },
        { name: "SECTORS", data: sectors(2) },
      ],
    });
    const wad = WadFile.parse(input);
    expect(wad.maps[0]!.dataIndices).toEqual([1, 2]);
    expectReadableNotWritable(wad, input, 4);
    // 同一张地图里作用域之内的 THINGS 仍可写
    expect(wad.setField(1, "Thing", 0, "x", 5)).toEqual({ start: wad.lumps[1]!.filepos, end: wad.lumps[1]!.filepos + 2 });
  });

  it("对照：同样的 SECTORS 字节放进 MAP01 的作用域后可写", () => {
    const input = buildWad({ kind: "PWAD", lumps: [{ name: "MAP01", data: empty }, { name: "SECTORS", data: sectors(2) }] });
    const wad = WadFile.parse(input);
    const lump = wad.mapLump(wad.findMap("MAP01")!, "SECTORS")!.index;
    const span = wad.setField(lump, "Sector", 1, "lightlevel", 77);
    expect(span).toEqual(wad.fieldSpan(lump, "Sector", 1, "lightlevel"));
    expect(wad.readRecord(lump, "Sector", 1).lightlevel).toBe(77);
  });

  it("参数类错误先于作用域拒绝报告", () => {
    const input = buildWad({ kind: "PWAD", lumps: [{ name: "SECTORS", data: sectors(2) }] });
    const wad = WadFile.parse(input);
    expect(() => wad.setField(0, "Sector", 0, "lightlevel", 40000)).toThrow(RangeError);
    expect(() => wad.setField(0, "Sector", 9, "lightlevel", 1)).toThrow(RangeError);
    expect(() => wad.setField(0, "Sector", 0, "floorpic", "TOOLONGNAME")).toThrow(RangeError);
    expect(() => wad.setField(0, "Thing", 0, "x", 1)).toThrow(TypeError); // Lump 名称与记录类型不符
    expect(wad.dirtySpans()).toEqual([]);
  });
});

describe("D-6 ByteOverlay 不在 @necrohex/core 的公开入口", () => {
  // core 包内的同类断言在 packages/core/test/public-api.test.ts；这里从依赖方的角度按包名解析，不重复实现
  it("按包名导入公开入口得不到 ByteOverlay，内部子路径可解析", () => {
    expect("ByteOverlay" in core).toBe(false);
    expect(typeof coreInternal.ByteOverlay).toBe("function");
  });

  it("adapter-wad 的公开入口也不导出 ByteOverlay", async () => {
    const adapter = await import("../src/index.ts");
    expect("ByteOverlay" in adapter).toBe(false);
  });
});

describe("F-3 fieldSpan 对继承自 Object.prototype 的字段名抛 RangeError", () => {
  const mapped = () => {
    const wad = WadFile.parse(
      buildWad({ kind: "PWAD", lumps: [{ name: "MAP01", data: new Uint8Array(0) }, { name: "SECTORS", data: new Uint8Array(52) }] }),
    );
    return { wad, lump: wad.mapLump(wad.findMap("MAP01")!, "SECTORS")!.index };
  };
  const inherited = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];

  it.each(inherited)("fieldSpan(…, %s) 抛 RangeError，不返回 NaN 区间", (name) => {
    const { wad, lump } = mapped();
    // 类型上字段名受限；这里有意传入不在布局里的名称
    expect(() => wad.fieldSpan(lump, "Sector", 0, name as "tag")).toThrow(RangeError);
  });

  it.each(inherited)("setField(…, %s) 抛 RangeError，dirtySpans() 为空", (name) => {
    const { wad, lump } = mapped();
    expect(() => wad.setField(lump, "Sector", 0, name as "tag", 1)).toThrow(RangeError);
    expect(wad.dirtySpans()).toEqual([]);
  });

  it("合法字段名与不存在的字段名的行为不变", () => {
    const { wad, lump } = mapped();
    const base = wad.recordSpan(lump, "Sector", 1).start;
    expect(wad.fieldSpan(lump, "Sector", 1, "tag")).toEqual({ start: base + 24, end: base + 26 });
    expect(() => wad.fieldSpan(lump, "Sector", 0, "nonexistent" as "tag")).toThrow(RangeError);
  });
});

describe("X-3 带 BEHAVIOR 的 Hexen 地图不按 Doom 布局访问记录", () => {
  it("readRecords(THINGS, Thing) 抛 UNSUPPORTED_MAP_FORMAT，而不是把 20 字节一条的 THINGS 读成 10 字节一条", () => {
    const input = buildWad({
      kind: "PWAD",
      lumps: [
        { name: "MAP01", data: new Uint8Array(0) },
        { name: "THINGS", data: new Uint8Array(40) }, // Hexen：2 条 × 20 字节；按 Doom 布局会算成 4 条
        { name: "LINEDEFS", data: new Uint8Array(32) },
        { name: "BEHAVIOR", data: new Uint8Array(8) },
      ],
    });
    const wad = WadFile.parse(input);
    expect(wad.maps[0]!.format).toBe("hexen");
    let thrown: unknown;
    try {
      wad.readRecords(1, "Thing");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(WadRecordError);
    expect((thrown as WadRecordError).code).toBe("UNSUPPORTED_MAP_FORMAT");
    // 其余接口不受限，往返照常
    expect(wad.lumpBytes(1)).toHaveLength(40);
    expect(equalBytes(wad.serialize(), input)).toBe(true);
  });
});
