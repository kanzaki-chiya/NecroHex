/**
 * 回归用例：每个由属性测试或人工核对发现的缺陷对应一个命名用例，用例名以缺陷编号开头。
 * wad-roundtrip 的编号对应 .kiro/specs/wad-roundtrip/design.md 的"已知差异与风险"。
 * 已有用例（按实施顺序）：D-5、X-1、X-4、D-6、F-3、X-3。
 * patch-engine 的用例以 P<属性编号>-<序号> 开头，对应 .kiro/specs/patch-engine/design.md 的 Correctness Properties；
 * 另有 PE- 开头的固定例子（tasks.md 7.15 列出的必备用例）。
 * Property 16（SHA-256 差分，任务 1.3）和 Property 1、2、5–15 在实现过程中没有找到反例。
 * P3-3 是实现 pin 重定位（docs/design.md 第 7 节，没有单独的 Spec）之后 Property 3 找到的反例。
 */
import { describe, expect, it } from "vitest";
import * as core from "@necrohex/core";
import { applyPatch, planPatch, revertPatch, type Receipt } from "@necrohex/core";
import * as coreInternal from "@necrohex/core/internal";
import { buildWad, MAP_DATA_LUMPS, wadAdapter, WadFile, WadRecordError } from "../src/index.ts";
import { equalBytes, withFilepos } from "./helpers.ts";
import { FIXTURE, flatsAdapter } from "./patch-helpers.ts";

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

// ---------------------------------------------------------------------------
// patch-engine
// ---------------------------------------------------------------------------

/** 一张 MAP01：给定 SECTORS 和 THINGS 数据，其余数据 Lump 各 4 字节。 */
function oneMap(sectors: Uint8Array, things: Uint8Array = new Uint8Array(10)): Uint8Array {
  return buildWad({
    kind: "PWAD",
    lumps: [
      { name: "MAP01", data: new Uint8Array(0) },
      ...MAP_DATA_LUMPS.map((n) => ({ name: n, data: n === "SECTORS" ? sectors : n === "THINGS" ? things : new Uint8Array(4) })),
    ],
  });
}

/** 扇区原始字节：floorpic 为给定 8 字节，lightlevel、special 为给定值。 */
function sector(pic: number[], lightlevel = 160, special = 0): Uint8Array {
  const raw = new Uint8Array(26);
  raw.set(pic, 4);
  const v = new DataView(raw.buffer);
  v.setInt16(20, lightlevel, true);
  v.setInt16(22, special, true);
  return raw;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const patchOf = (operations: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  name: "regression",
  target: { format: "wad", maps: "*" },
  operations,
  ...extra,
});

describe("P3-1 set 补丁的选择器按当前输入求值：跨操作读取时再应用会选中新记录", () => {
  // Property 3 在生成样本上找到的反例（缩减后）：op1 把所有 Thing 的 x 设成 23402，
  // op0 的 where 读取 x。第一次应用时 op0 按输入值求值、匹配 0 条；对输出再应用时匹配 1 条，flags 被改，结果不再是 O。
  // 这是选择器语义（写入前、按输入值求值），不是缺陷；Property 3 因此加上"没有跨操作读取"的前提。
  // 原反例里 op1 还把 type 设为 -32768。加入护栏后未知类型会被 thing-type-known 拒绝，而这个写入与选择器语义无关，所以去掉。
  const things = new Uint8Array(10);
  new DataView(things.buffer).setInt16(0, -202, true);
  const bytes = oneMap(new Uint8Array(26), things);
  const patch = patchOf([
    { id: "op0", select: { record: "Thing", where: { x: { ne: -202 }, angle: { gte: -202, lte: 0 } } }, change: { flags: { set: 23402 } } },
    { id: "op1", select: { record: "Thing", all: true }, change: { x: { set: 23402 }, y: { set: -202 } } },
  ]);

  it("第一次应用：op0 按输入值匹配 0 条", () => {
    const first = applyPatch(bytes, patch, wadAdapter);
    expect(first.ok).toBe(true);
    expect(first.matches).toEqual([
      { operationId: "op0", count: 0 },
      { operationId: "op1", count: 1 },
    ]);
  });

  it("对输出以 allowReapply 再应用：op0 匹配 1 条，flags 被改", () => {
    const first = applyPatch(bytes, patch, wadAdapter);
    const second = applyPatch(first.output!, patch, wadAdapter, { allowReapply: true });
    expect(second.ok).toBe(true);
    expect(second.matches[0]).toEqual({ operationId: "op0", count: 1 });
    expect(second.changedCount).toBe(1);
    expect(equalBytes(second.output!, first.output!)).toBe(false);
  });
});

describe("P3-2 再应用设置了非零 special 的补丁会被 sector-special-nonzero 拦下", () => {
  // Property 3 在 Freedoom 夹具上找到的反例：MAP01 #0 的 special 原为 0，第一次 set 为 1 成功；
  // 再应用时旧值是 1（非零），保护钩子按规则拦截。保护不放宽，显式 opt-in 后结果仍是 O。
  const patch = patchOf([{ id: "op0", select: { record: "Sector", pin: { map: "MAP01", expectedIndex: 0 } }, change: { special: { set: 1 }, tag: { set: -32768 } } }]);

  it("夹具 MAP01 #0 的 special 原为 0", () => {
    expect(wadAdapter.open(FIXTURE).readField({ scope: "MAP01", record: "Sector", index: 0 }, "special")).toBe(0);
  });

  it("再应用为 PROTECTED；opt-in 后得到同一份字节", () => {
    const first = applyPatch(FIXTURE, patch, wadAdapter);
    expect(first.ok).toBe(true);
    const second = applyPatch(first.output!, patch, wadAdapter, { allowReapply: true });
    expect(second.ok).toBe(false);
    expect(second.issues).toEqual([expect.objectContaining({ code: "PROTECTED", hook: "sector-special-nonzero", operationId: "op0", field: "special" })]);
    const optIn = applyPatch(first.output!, { ...patch, allowProtected: ["sector-special-nonzero"] }, wadAdapter, { allowReapply: true });
    expect(optIn.ok).toBe(true);
    expect(equalBytes(optIn.output!, first.output!)).toBe(true);
  });
});

describe("P3-3 带指纹的 pin 改了自己指纹里的字段，再应用时不再符合指纹", () => {
  // Property 3 在生成样本上找到的反例（缩减后）：E1M1 #1 的 pin 带该扇区的真实指纹，同一操作把 ceilingheight 和 tag 改掉。
  // 第一次应用 EXACT；对输出再应用时，扇区的 tag 和高度已与指纹不同，相似度 0.8 低于 0.85，按规则为 CONFLICT_AMBIGUOUS。
  // 这是指纹语义，不是缺陷，引擎不放宽；Property 3 的前提加上"带指纹的 pin 不读取补丁写入的指纹字段"。
  // 2026-11-09 指纹加入 bbox 和面积、几何权重合计 0.7 之后：这个扇区没有线段，三个几何量都为 null，两边一致各得满分，
  // 高度只对一半、tag 不同，相似度为 0.9，再应用时仍是 EXACT。用例保留，断言改为新权重下的结果。
  const raw = sector([0x41, 0]);
  const v = new DataView(raw.buffer);
  v.setInt16(2, 128, true); // ceilingheight
  v.setInt16(24, 7, true); // tag
  const bytes = oneMap(raw);
  const fingerprint = wadAdapter.open(bytes).fingerprints!.compute({ scope: "MAP01", record: "Sector", index: 0 });
  const patch = patchOf([
    { id: "op0", select: { record: "Sector", pin: { map: "MAP01", expectedIndex: 0, fingerprint } }, change: { ceilingheight: { set: 256 }, tag: { set: 0 } } },
  ]);

  it("指纹没有几何数据（没有线段）", () => {
    expect(fingerprint).toEqual({ tag: 7, floorpic: "A", ceilingpic: "", heights: [0, 128], centroid: null, bbox: null, area: null, lineCount: 0 });
  });

  it("第一次 EXACT，相似度 1；再应用时高度和 tag 已不同，相似度 0.9，仍为 EXACT", () => {
    const first = applyPatch(bytes, patch, wadAdapter);
    expect(first.ok).toBe(true);
    expect(first.pins).toEqual([expect.objectContaining({ result: "EXACT", index: 0, score: 1, fingerprintChecked: true })]);
    const second = applyPatch(first.output!, patch, wadAdapter, { allowReapply: true });
    expect(second.issues).toEqual([]);
    expect(second.pins).toEqual([expect.objectContaining({ result: "EXACT", index: 0, score: 0.9, fingerprintChecked: true })]);
  });
});

describe("P4-1 名称比较只折叠 ASCII 大小写", () => {
  // Property 4 的测试最初用 String.prototype.toLowerCase 改写条件，生成样本里 floorpic 含 latin1 字母（如 0xC9 'É'），
  // 被改成 0xE9 'é' 后不再匹配。规则是只折叠 ASCII a–z，所以 'É' 与 'é' 是不同名称；测试改为只改 ASCII。
  const bytes = oneMap(concat(sector([0xc9, 0x41, 0]), sector([0xe9, 0x61, 0])));
  const matched = (eq: string) =>
    planPatch(bytes, patchOf([{ id: "n", select: { record: "Sector", where: { floorpic: { eq } } }, change: { tag: { set: 1 } } }]), wadAdapter).changes.map((c) => c.index);

  it("扇区 #0 为 'ÉA'、#1 为 'éa'：ASCII 部分不分大小写，'É' 与 'é' 不同", () => {
    expect(matched("\u00c9A")).toEqual([0]);
    expect(matched("\u00c9a")).toEqual([0]);
    expect(matched("\u00e9a")).toEqual([1]);
    expect(matched("\u00e9A")).toEqual([1]);
    expect(matched("EA")).toEqual([]);
  });
});

describe("PE-1 非零 special 默认受保护", () => {
  it("覆盖 special = 9 的扇区为 PROTECTED，无字节；opt-in 后成功", () => {
    const bytes = oneMap(sector([0x46, 0x31, 0], 160, 9));
    const patch = patchOf([{ id: "s", select: { record: "Sector", all: true }, change: { special: { set: 0 } } }]);
    const r = applyPatch(bytes, patch, wadAdapter);
    expect(r.issues).toEqual([expect.objectContaining({ code: "PROTECTED", hook: "sector-special-nonzero", operationId: "s" })]);
    expect(r.output).toBeUndefined();
    expect(applyPatch(bytes, { ...patch, allowProtected: ["sector-special-nonzero"] }, wadAdapter).ok).toBe(true);
  });
});

describe("PE-2 同名地图的 pin 为 CONFLICT_AMBIGUOUS", () => {
  it("两张 MAP01，pin MAP01 #0 不猜测", () => {
    const one = WadFile.parse(oneMap(sector([0x41, 0])));
    const lumps = one.lumps.map((l) => ({ name: l.name, data: one.lumpBytes(l.index) }));
    const bytes = buildWad({ kind: "PWAD", lumps: [...lumps, ...lumps] });
    const r = applyPatch(bytes, patchOf([{ id: "p", select: { record: "Sector", pin: { map: "MAP01", expectedIndex: 0 } }, change: { tag: { set: 1 } } }]), wadAdapter);
    expect(r.issues).toEqual([expect.objectContaining({ code: "CONFLICT_AMBIGUOUS", operationId: "p" })]);
    expect(r.output).toBeUndefined();
  });
});

describe("PE-3 OLD_VALUE_NOT_RESTORABLE", () => {
  it("floorpic 第一个 NUL 后有非零字节：拒绝写入并写明作用域、下标和字段名", () => {
    const bytes = oneMap(concat(sector([0x41, 0x42, 0, 0x37]), sector([0x41, 0])));
    // 基础 IWAD 提供 BLOOD1，否则新贴图名会先被 flat-exists 拒绝
    const r = applyPatch(bytes, patchOf([{ id: "pic", select: { record: "Sector", all: true }, change: { floorpic: { set: "BLOOD1" } } }]), flatsAdapter);
    expect(r.ok).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({
      code: "VALUE_REJECTED",
      reason: "OLD_VALUE_NOT_RESTORABLE",
      operationId: "pic",
      locator: { scope: "MAP01", record: "Sector", index: 0 },
      field: "floorpic",
    });
    expect(r.issues[0]!.message).toContain("MAP01 Sector #0 floorpic");
    expect(r.changes.map((c) => c.index)).toEqual([1]);
  });
});

describe("PE-4 空串和非 ASCII 的历史 name8 经应用和撤销不变", () => {
  it.each([
    ["空串（8 个 NUL）", [0, 0, 0, 0, 0, 0, 0, 0]],
    ["非 ASCII latin1", [0xc9, 0xff, 0x80, 0x01, 0]],
    ["8 字节无 NUL", [0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0xfe]],
  ])("%s", (_name, pic) => {
    const bytes = oneMap(sector(pic));
    const patch = patchOf([{ id: "pic", select: { record: "Sector", all: true }, change: { floorpic: { set: "BLOOD1" }, ceilingpic: { set: "CEIL1" } } }]);
    // 基础 IWAD 提供 BLOOD1 和 CEIL1；撤销用同一个 adapter
    const r = applyPatch(bytes, patch, flatsAdapter);
    expect(r.issues).toEqual([]);
    const back = revertPatch(r.output!, JSON.parse(JSON.stringify(r.receipt)), flatsAdapter);
    expect(back.issues).toEqual([]);
    expect(equalBytes(back.output!, bytes)).toBe(true);
  });
});

describe("PE-5 越界整数写回被拒绝", () => {
  it("伪造回执把 oldValue 改成 40000：RECEIPT_MISMATCH，reason 为 ENCODE，带定位，无字节", () => {
    const bytes = oneMap(sector([0x41, 0]));
    const r = applyPatch(bytes, patchOf([{ id: "dim", select: { record: "Sector", all: true }, change: { lightlevel: { scale: 0.5 } } }]), wadAdapter);
    const forged = JSON.parse(JSON.stringify(r.receipt)) as { entries: Array<Record<string, unknown>> };
    forged.entries[0]!.oldValue = 40000;
    const back = revertPatch(r.output!, forged as unknown as Receipt, wadAdapter);
    expect(back.ok).toBe(false);
    expect(back.output).toBeUndefined();
    expect(back.issues).toEqual([
      expect.objectContaining({ code: "RECEIPT_MISMATCH", reason: "ENCODE", locator: { scope: "MAP01", record: "Sector", index: 0 }, field: "lightlevel" }),
    ]);
    expect(back.issues[0]!.message).toContain("MAP01 Sector #0 lightlevel");
  });
});
