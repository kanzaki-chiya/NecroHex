import { describe, expect, it } from "vitest";
import { applyPatch, bytesHash, patchHash, planPatch, revertPatch, type ProtectionHook, type Receipt } from "../src/index.ts";
import { registerRestorer } from "../src/internal.ts";
import { decodeModel, encodeModel, key, makeFake, sampleModel } from "./fake-source.ts";

const input = () => encodeModel(sampleModel());

function patch(operations: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, name: "t", target: { format: "fake", maps: "*" }, operations, ...extra };
}

const dim = { id: "dim", select: { record: "Sector", where: { lightlevel: { gte: 140 } } }, change: { lightlevel: { scale: 0.5 } } };

function applied(ops: unknown[] = [dim]) {
  const fake = makeFake();
  const src = input();
  const r = applyPatch(src, patch(ops), fake.adapter);
  expect(r.ok).toBe(true);
  return { fake, src, output: r.output!, receipt: JSON.parse(JSON.stringify(r.receipt)) as Receipt };
}

describe("保护钩子", () => {
  const block: ProtectionHook = {
    name: "special-nonzero",
    severity: "block",
    check: (c, reader) => (c.field === "special" && reader.readField(c, "special") !== 0 ? "special is non-zero" : null),
  };
  const warn: ProtectionHook = { name: "loud", severity: "warn", check: (c) => (c.field === "lightlevel" ? "lighting changed" : null) };
  const op = { id: "s", select: { record: "Sector", all: true }, change: { special: { set: 1 } } };

  it("block 未 opt-in 为 PROTECTED，带钩子名、操作和记录，无字节", () => {
    const fake = makeFake({ hooks: [block] });
    const r = applyPatch(input(), patch([op], { target: { format: "fake", maps: ["MAP01"] } }), fake.adapter);
    expect(r.ok).toBe(false);
    expect(r.output).toBeUndefined();
    expect(r.receipt).toBeUndefined();
    expect(r.issues).toEqual([
      expect.objectContaining({ code: "PROTECTED", hook: "special-nonzero", operationId: "s", locator: { scope: "MAP01", record: "Sector", index: 2 }, field: "special" }),
    ]);
  });

  it("allowProtected 放行，并记入 allowedProtections", () => {
    const fake = makeFake({ hooks: [block] });
    const r = applyPatch(input(), patch([op], { allowProtected: ["special-nonzero"] }), fake.adapter);
    expect(r.ok).toBe(true);
    expect(r.receipt!.allowedProtections).toEqual(["special-nonzero"]);
  });

  it("放行了但没有触发的钩子不记入 allowedProtections", () => {
    const fake = makeFake({ hooks: [block] });
    const r = applyPatch(input(), patch([dim], { allowProtected: ["special-nonzero"] }), fake.adapter);
    expect(r.ok).toBe(true);
    expect(r.receipt!.allowedProtections).toEqual([]);
  });

  it("warn 报告警告并继续", () => {
    const fake = makeFake({ hooks: [warn] });
    const r = applyPatch(input(), patch([dim]), fake.adapter);
    expect(r.ok).toBe(true);
    expect(r.output).toBeDefined();
    expect(r.warnings.length).toBe(r.changes.length);
    expect(r.warnings[0]).toMatchObject({ code: "WARNING", hook: "loud", operationId: "dim" });
  });

  it("allowProtected 含未注册钩子为 INVALID_PATCH，不打开 Record_Source", () => {
    const fake = makeFake({ hooks: [block] });
    const r = applyPatch(input(), patch([dim], { allowProtected: ["nope"] }), fake.adapter);
    expect(r.issues).toEqual([expect.objectContaining({ code: "INVALID_PATCH", path: "/allowProtected/0" })]);
    expect(fake.counts.open).toBe(0);
  });
});

describe("OLD_VALUE_NOT_RESTORABLE", () => {
  it("message 写明作用域、下标和字段名，不写入该条目", () => {
    const fake = makeFake({ notRestorable: [key({ scope: "MAP01", record: "Sector", index: 1 }, "floorpic")] });
    const op = { id: "pic", select: { record: "Sector", all: true }, change: { floorpic: { set: "BLOOD1" } } };
    const r = planPatch(input(), patch([op], { target: { format: "fake", maps: ["MAP01"] } }), fake.adapter);
    expect(r.ok).toBe(false);
    expect(r.issues).toHaveLength(1);
    const issue = r.issues[0]!;
    expect(issue).toMatchObject({
      code: "VALUE_REJECTED",
      reason: "OLD_VALUE_NOT_RESTORABLE",
      operationId: "pic",
      locator: { scope: "MAP01", record: "Sector", index: 1 },
      field: "floorpic",
    });
    expect(issue.message).toContain("MAP01 Sector #1 floorpic");
    expect(r.changes.map((c) => c.index)).toEqual([0, 2]);
  });
});

describe("重复应用", () => {
  it("带回执对输出再应用为 ALREADY_APPLIED，allowReapply 跳过", () => {
    const { fake, output, receipt } = applied();
    const again = applyPatch(output, patch([dim]), fake.adapter, { receipts: [receipt] });
    expect(again.ok).toBe(false);
    expect(again.issues).toEqual([expect.objectContaining({ code: "ALREADY_APPLIED" })]);
    expect(again.output).toBeUndefined();
    const forced = applyPatch(output, patch([dim]), fake.adapter, { receipts: [receipt], allowReapply: true });
    expect(forced.ok).toBe(true);
  });

  it("对原输入带回执应用不是重复应用", () => {
    const { fake, src, receipt } = applied();
    expect(applyPatch(src, patch([dim]), fake.adapter, { receipts: [receipt] }).ok).toBe(true);
  });

  it("不合法的回执为 INVALID_RECEIPT", () => {
    const { fake, output, receipt } = applied();
    const broken = { ...receipt, outputHash: "sha256:XYZ" };
    const r = applyPatch(output, patch([dim]), fake.adapter, { receipts: [broken] });
    expect(r.issues).toEqual([expect.objectContaining({ code: "INVALID_RECEIPT", path: "/receipts/0/outputHash" })]);
    expect(r.output).toBeUndefined();
  });
});

describe("INVALID_RECEIPT（撤销）", () => {
  it.each([
    ["多出的键", (r: Receipt) => ({ ...r, extra: 1 })],
    ["缺少 entries", (r: Receipt) => ({ ...r, entries: undefined })],
    ["unchanged 不是布尔值", (r: Receipt) => ({ ...r, entries: r.entries.map((e) => ({ ...e, unchanged: "no" })) })],
    ["selection.kind 不合法", (r: Receipt) => ({ ...r, entries: r.entries.map((e) => ({ ...e, selection: { kind: "GUESS" } })) })],
    ["哈希为大写", (r: Receipt) => ({ ...r, inputHash: r.inputHash.toUpperCase() })],
    ["entry 带 offset", (r: Receipt) => ({ ...r, entries: r.entries.map((e) => ({ ...e, offset: 3 })) })],
  ])("%s", (_name, mutate) => {
    const { fake, output, receipt } = applied();
    const r = revertPatch(output, JSON.parse(JSON.stringify(mutate(receipt))), fake.adapter);
    expect(r.ok).toBe(false);
    expect(r.issues.every((i) => i.code === "INVALID_RECEIPT")).toBe(true);
    expect(r.output).toBeUndefined();
    expect(fake.counts.restoreField).toBe(0);
  });
});

describe("CONFLICT_FIELD", () => {
  it("两个操作写同一字段，列出两个 id，不返回字节", () => {
    const fake = makeFake();
    const a = { id: "a", select: { record: "Sector", all: true }, change: { tag: { set: 1 } } };
    const b = { id: "b", select: { record: "Sector", pin: { map: "MAP02", expectedIndex: 1 } }, change: { tag: { set: 2 } } };
    const r = applyPatch(input(), patch([a, b]), fake.adapter);
    expect(r.ok).toBe(false);
    expect(r.output).toBeUndefined();
    expect(r.issues).toEqual([
      expect.objectContaining({ code: "CONFLICT_FIELD", operationIds: ["a", "b"], locator: { scope: "MAP02", record: "Sector", index: 1 }, field: "tag" }),
    ]);
    // 卷入冲突的两条都不写入
    expect(r.changes.some((c) => c.scope === "MAP02" && c.index === 1)).toBe(false);
  });
});

describe("RECEIPT_MISMATCH", () => {
  it("输入哈希不等于 outputHash：不打开写回数据源", () => {
    const { fake, src, receipt } = applied();
    const r = revertPatch(src, receipt, fake.adapter);
    expect(r.issues).toEqual([expect.objectContaining({ code: "RECEIPT_MISMATCH", path: "/outputHash" })]);
    expect(fake.counts.restorableOpen).toBe(0);
  });

  /** 改写输出里的模型，同时把回执的 outputHash 改成新字节的哈希，使第 3 步通过。 */
  function forge(mutate: (r: Receipt) => Receipt) {
    const a = applied();
    const receipt = mutate(a.receipt);
    return { ...a, receipt };
  }

  it("作用域不存在", () => {
    const { fake, output, receipt } = forge((r) => ({ ...r, entries: r.entries.map((e, i) => (i === 0 ? { ...e, scope: "MAP09" } : e)) }));
    const r = revertPatch(output, receipt, fake.adapter);
    expect(r.issues).toEqual([expect.objectContaining({ code: "RECEIPT_MISMATCH", path: "/entries/0", field: "lightlevel" })]);
    expect(fake.counts.restoreField).toBe(0);
  });

  it("区间不符", () => {
    const { fake, output, receipt } = forge((r) => ({ ...r, entries: r.entries.map((e, i) => (i === 1 ? { ...e, span: { start: 0, end: 8 } } : e)) }));
    const r = revertPatch(output, receipt, fake.adapter);
    expect(r.issues).toEqual([expect.objectContaining({ code: "RECEIPT_MISMATCH", path: "/entries/1" })]);
    expect(fake.counts.restoreField).toBe(0);
  });

  it("新值不符（逐条收集）", () => {
    const { fake, output, receipt } = forge((r) => ({ ...r, entries: r.entries.map((e) => ({ ...e, newValue: 1234 })) }));
    const r = revertPatch(output, receipt, fake.adapter);
    expect(r.issues).toHaveLength(receipt.entries.length);
    expect(r.issues.every((i) => i.code === "RECEIPT_MISMATCH")).toBe(true);
    expect(fake.counts.restoreField).toBe(0);
  });

  it("记录或字段不存在", () => {
    const { fake, output, receipt } = forge((r) => ({ ...r, entries: r.entries.map((e, i) => (i === 0 ? { ...e, index: 99 } : e)) }));
    const r = revertPatch(output, receipt, fake.adapter);
    expect(r.issues).toEqual([expect.objectContaining({ code: "RECEIPT_MISMATCH", path: "/entries/0" })]);
  });

  it("restoreField 拒绝：带该条 locator、field、reason，无字节", () => {
    const fake = makeFake({ restoreFails: [key({ scope: "MAP02", record: "Sector", index: 0 }, "lightlevel")] });
    const a = applyPatch(input(), patch([dim]), fake.adapter);
    expect(a.ok).toBe(true);
    const r = revertPatch(a.output!, a.receipt, fake.adapter);
    expect(r.ok).toBe(false);
    expect(r.output).toBeUndefined();
    expect(r.issues).toEqual([
      expect.objectContaining({
        code: "RECEIPT_MISMATCH",
        reason: "RESTORE_REJECTED",
        locator: { scope: "MAP02", record: "Sector", index: 0 },
        field: "lightlevel",
      }),
    ]);
    expect(r.issues[0]!.message).toContain("MAP02 Sector #0 lightlevel");
  });

  it("撤销结果哈希不等于 inputHash", () => {
    const { fake, output, receipt } = applied();
    const other = bytesHash(Uint8Array.of(1));
    const r = revertPatch(output, { ...receipt, inputHash: other }, fake.adapter);
    expect(r.issues).toEqual([expect.objectContaining({ code: "RECEIPT_MISMATCH", path: "/inputHash" })]);
    expect(r.output).toBeUndefined();
  });

  it("对照：未改动的回执撤销成功并还原输入", () => {
    const { fake, src, output, receipt } = applied();
    const r = revertPatch(output, receipt, fake.adapter);
    expect(r.ok).toBe(true);
    expect([...r.output!]).toEqual([...src]);
  });
});

describe("写回通道登记", () => {
  it("未登记的 adapter 撤销时抛 TypeError", () => {
    const fake = makeFake({ unregistered: true });
    const a = applyPatch(input(), patch([dim]), fake.adapter);
    expect(() => revertPatch(a.output!, a.receipt, fake.adapter)).toThrow(TypeError);
  });

  it("回执结构不合法时先报 INVALID_RECEIPT，不查登记表", () => {
    const fake = makeFake({ unregistered: true });
    expect(revertPatch(input(), {}, fake.adapter).issues[0]!.code).toBe("INVALID_RECEIPT");
  });

  it("重复登记抛错", () => {
    const fake = makeFake();
    expect(() => registerRestorer(fake.adapter, () => {
      throw new Error("never");
    })).toThrow();
  });
});

describe("选择器", () => {
  it("all 在缺该 Lump 的作用域匹配 0，不是问题", () => {
    const fake = makeFake();
    const model = sampleModel();
    delete model.data.MAP02!.Thing;
    const t = { id: "t", select: { record: "Thing", all: true }, change: { x: { set: 1 } } };
    const r = planPatch(encodeModel(model), patch([t], { target: { format: "fake", maps: ["MAP02"] } }), fake.adapter);
    expect(r.ok).toBe(true);
    expect(r.matches).toEqual([{ operationId: "t", count: 0 }]);
    expect(r.changes).toEqual([]);
  });

  it("名称条件不区分 ASCII 大小写", () => {
    const fake = makeFake();
    const op = { id: "n", select: { record: "Sector", where: { floorpic: { eq: "NUKAGE1" } } }, change: { tag: { set: 7 } } };
    const r = planPatch(input(), patch([op]), fake.adapter);
    expect(r.matches).toEqual([{ operationId: "n", count: 2 }]);
  });

  it("target.maps 中不存在的地图为 CONFLICT_MISSING", () => {
    const fake = makeFake();
    const r = planPatch(input(), patch([dim], { target: { format: "fake", maps: ["MAP01", "MAP07"] } }), fake.adapter);
    expect(r.issues).toEqual([expect.objectContaining({ code: "CONFLICT_MISSING", path: "/target/maps/1" })]);
  });
});

describe("只读记录", () => {
  it("修改只读记录为 INVALID_PATCH", () => {
    const fake = makeFake();
    const op = { id: "v", select: { record: "Vertex", all: true }, change: { x: { set: 1 } } };
    const r = planPatch(input(), patch([op]), fake.adapter);
    expect(r.issues).toEqual([expect.objectContaining({ code: "INVALID_PATCH", operationId: "v", path: "/operations/0/select/record" })]);
  });
});

describe("unchanged 与 changedCount", () => {
  it("新值等于旧值照常写入并记入回执", () => {
    const fake = makeFake();
    const ops = [
      { id: "same", select: { record: "Thing", where: { type: { eq: 1 } } }, change: { type: { set: 1 } } },
      { id: "diff", select: { record: "Thing", where: { type: { ne: 1 } } }, change: { x: { set: 100 } } },
    ];
    const r = applyPatch(input(), patch(ops), fake.adapter);
    expect(r.ok).toBe(true);
    expect(r.changes.map((c) => [c.operationId, c.scope, c.unchanged])).toEqual([
      ["same", "MAP01", true],
      ["same", "MAP02", true],
      ["diff", "MAP01", false],
      ["diff", "MAP02", false],
    ]);
    expect(r.changedCount).toBe(2);
    expect(r.receipt!.entries).toHaveLength(4);
    const back = decodeModel(r.output!);
    expect(back.data.MAP01!.Thing![1]!.x).toBe(100);
  });
});

describe("patchHash", () => {
  it("重排键和空白不改变结果；name 计入", () => {
    const p = patch([dim]);
    const reordered = JSON.parse(JSON.stringify({ operations: p.operations, target: p.target, name: p.name, schemaVersion: 1 }, null, 4));
    expect(patchHash(reordered)).toBe(patchHash(p));
    expect(patchHash({ ...p, name: "other" })).not.toBe(patchHash(p));
    expect(patchHash(p)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("结构不合法时抛 TypeError", () => {
    expect(() => patchHash({ ...patch([dim]), offset: 4 })).toThrow(TypeError);
  });
});
