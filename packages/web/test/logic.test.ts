import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytesHash } from "@necrohex/core";
import { buildWad } from "@necrohex/adapter-wad";
import { describe, expect, it } from "vitest";
import {
  activePatch,
  defaultWadName,
  editorOperation,
  editorValues,
  exportFileName,
  hexRows,
  indexPlan,
  initialSelection,
  isEdited,
  issueGroups,
  opControl,
  operationsOf,
  opRows,
  patchFileName,
  pinCards,
  receiptFileName,
  recordView,
  removeOperation,
  setChangeParam,
  stripHookNote,
  upsertOperation,
  verdictView,
  decodeRecord,
  type Json,
} from "../src/state/logic.ts";
import { BUILTIN_PRESETS, CARELESS_EDIT } from "../src/state/presets.ts";
import type { PlanView } from "../src/worker/protocol.ts";
import { Session } from "../src/worker/session.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const FIXTURE = new Uint8Array(readFileSync(resolve(REPO, "packages/adapter-wad/fixtures/freedoom/freedoom2-map01-02.wad")));
const BASE = buildWad({ kind: "IWAD", lumps: [{ name: "F_START", data: new Uint8Array(0) }, { name: "BLOOD1", data: new Uint8Array(4096) }, { name: "F_END", data: new Uint8Array(0) }] });
const session = new Session();
session.open("base.wad", BASE, { sha256: bytesHash(BASE).slice(7), version: "t" });
session.open("fixture.wad", FIXTURE);
const map01 = session.mapData("MAP01");
const HAUNTED = BUILTIN_PRESETS[0]!.patch;
const RELOCATION = BUILTIN_PRESETS[1]!.patch;

describe("补丁编辑", () => {
  it("关闭的操作不交给引擎；isEdited 看补丁和开关", () => {
    const off = new Set(["dim-lights"]);
    const active = activePatch(HAUNTED, off);
    expect(operationsOf(active).map((o) => o.id)).not.toContain("dim-lights");
    expect(operationsOf(HAUNTED).map((o) => o.id)).toContain("dim-lights");
    expect(isEdited(HAUNTED, HAUNTED, new Set())).toBe(false);
    expect(isEdited(HAUNTED, HAUNTED, off)).toBe(true);
    expect(isEdited(setChangeParam(HAUNTED, "dim-lights", "lightlevel", "scale", 0.5), HAUNTED, new Set())).toBe(true);
  });

  it("数值控件：scale 滑块、special 下拉框、名称文本框、类型数字框；pin 和多字段操作没有控件", () => {
    const ops = Object.fromEntries(operationsOf(HAUNTED).map((o) => [o.id, opControl(o)]));
    expect(ops["dim-lights"]).toEqual({ kind: "scale", field: "lightlevel", value: 0.7, clamp: [48, 255] });
    expect(ops["strobe-lamps"]).toEqual({ kind: "special", field: "special", value: 2 });
    expect(ops["blood-floors"]).toMatchObject({ kind: "text", value: "BLOOD1", list: "flatlist" });
    expect(ops["demons-to-spectres"]).toMatchObject({ kind: "number", value: "58", list: "typelist", hint: "Spectre" });
    expect(ops["strobe-start-map01"]).toBeNull();
  });

  it("setChangeParam 不改原对象", () => {
    const before = JSON.stringify(HAUNTED);
    const p = setChangeParam(HAUNTED, "blood-floors", "floorpic", "set", "NUKAGE1");
    expect(JSON.stringify(HAUNTED)).toBe(before);
    expect(operationsOf(p).find((o) => o.id === "blood-floors")!.change).toEqual({ floorpic: { set: "NUKAGE1" } });
  });

  it("导入的补丁不合法时只取出像操作的项，不抛错", () => {
    expect(operationsOf({ operations: [1, { id: 3, select: 2 }, { id: "a", change: { x: { set: 1 } } }] })).toEqual([
      { id: "#1", select: {}, change: {} },
      { id: "a", select: {}, change: { x: { set: 1 } } },
    ]);
    expect(operationsOf("nope")).toEqual([]);
  });
});

describe("编辑器", () => {
  const base = decodeRecord("Sector", map01.lumps.SECTORS!.bytes, 12);

  it("改扇区生成带指纹的 pin；没有改动时为 null", () => {
    const vals = editorValues(RELOCATION, { record: "Sector", index: 12 }, base);
    expect(editorOperation({ record: "Sector", index: 12 }, base, vals, "MAP01", map01.fingerprints[12])).toBeNull();
    const op = editorOperation({ record: "Sector", index: 12 }, base, { ...vals, floorpic: " BLOOD1 ", special: "8" }, "MAP01", map01.fingerprints[12])!;
    expect(op).toEqual({
      id: "edit-sector-12",
      select: { record: "Sector", pin: { map: "MAP01", expectedIndex: 12, fingerprint: JSON.parse(JSON.stringify(map01.fingerprints[12])) } },
      change: { floorpic: { set: "BLOOD1" }, special: { set: 8 } },
    });
    // 生成的 pin 在引擎里按指纹解析为 EXACT
    const p = session.plan(1, upsertOperation(RELOCATION, op, "MAP01"), "MAP01");
    expect(p.pins.find((x) => x.op === "edit-sector-12")).toMatchObject({ result: "EXACT", index: 12, fingerprintChecked: true });
  });

  it("改 Thing 按坐标和类型选中", () => {
    const t = decodeRecord("Thing", map01.lumps.THINGS!.bytes, 5);
    const op = editorOperation({ record: "Thing", index: 5 }, t, { type: "3001" }, "MAP01", undefined)!;
    expect(op["select"]).toEqual({ record: "Thing", where: { x: { eq: t["x"]! }, y: { eq: t["y"]! }, type: { eq: t["type"]! } } });
  });

  it("upsert 替换同 id 的操作，并把地图加进 target.maps；remove 删掉它；编辑器读出已有的值", () => {
    const op = { id: "edit-sector-1", select: { record: "Sector", pin: { map: "MAP03", expectedIndex: 1 } }, change: { lightlevel: { set: 9 } } };
    let p = upsertOperation(RELOCATION, op, "MAP03");
    p = upsertOperation(p, { ...op, change: { lightlevel: { set: 10 } } }, "MAP03");
    expect(operationsOf(p).filter((o) => o.id === "edit-sector-1")).toHaveLength(1);
    expect((p as { target: { maps: string[] } }).target.maps).toEqual(["MAP01", "MAP03"]);
    expect(editorValues(p, { record: "Sector", index: 1 }, base)["lightlevel"]).toBe("10");
    expect(operationsOf(removeOperation(p, "edit-sector-1")).map((o) => o.id)).toEqual(["blood-pool-map01"]);
    const star = upsertOperation({ target: { format: "wad", maps: "*" }, operations: [] }, op, "MAP03");
    expect((star as { target: { maps: string } }).target.maps).toBe("*");
  });
});

describe("补丁面板", () => {
  const haunted = session.plan(1, HAUNTED, "MAP01");
  const careless = session.plan(2, CARELESS_EDIT, "MAP01");
  const reloc = session.plan(3, RELOCATION, "MAP01");

  it("结论：可以写入时写当前地图的字段数和其他目标地图；未编辑且有回执时写哈希；警告数", () => {
    const receipt = { seq: 1, ok: true, patchHash: "p", inputHash: "i", outputHash: "sha256:b6b4259f24021d91f777f10f" };
    const v = verdictView(haunted, HAUNTED, "MAP01", false, receipt);
    expect(v).toEqual({
      ok: true,
      big: `Ready: ${haunted.changes.length} fields change in MAP01`,
      note: "Every other byte stays as it is. The patch also targets MAP02, not shown here.",
      hash: "receipt out sha256:b6b4259f24021d91…",
      warn: "1 warning below",
    });
    expect(verdictView(haunted, HAUNTED, "MAP01", true, receipt).hash).toBeNull();
    expect(verdictView(careless, CARELESS_EDIT, "MAP01", false, null)).toMatchObject({ ok: false, big: `Rejected: ${careless.issues.length} problems` });
  });

  it("pin 卡片：RELOCATED 标为待核对，EXACT 写相似度", () => {
    expect(pinCards(reloc.pins)).toEqual([expect.objectContaining({ pill: "review", pillText: "relocated · review", from: "#74", to: "#196", target: { scope: "MAP01", index: 196 } })]);
    expect(pinCards(reloc.pins)[0]!.msg).toContain("dashed outline");
    expect(pinCards(haunted.pins)[0]).toMatchObject({ pill: "exact", msg: "The fingerprint matches at the expected index (score 1)." });
  });

  it("操作行：当前地图改动的记录数、被拦下的数量、关闭的操作", () => {
    const rows = opRows(CARELESS_EDIT, new Set(), careless, null);
    expect(rows.map((r) => [r.id, r.count])).toEqual([
      ["starts-to-imps", "2 blocked"],
      ["long-flat-name", `${careless.issues.filter((i) => i.op === "long-flat-name").length} blocked`],
    ]);
    const off = opRows(HAUNTED, new Set(["dim-lights"]), haunted, "blood-floors");
    expect(off.find((r) => r.id === "dim-lights")).toMatchObject({ off: true, count: "off", control: null });
    expect(off.find((r) => r.id === "blood-floors")).toMatchObject({ focused: true, count: String(new Set(haunted.changes.filter((c) => c.op === "blood-floors").map((c) => c.index)).size) });
  });

  it("原因分组：同一操作、同一说明的记录合成一张卡片；警告按钩子分组", () => {
    const g = issueGroups(careless);
    const flat = g.issues.find((c) => c.code === "VALUE_REJECTED · long-flat-name")!;
    expect(flat.m).toBe("Sector.floorpic: name must be 1 to 8 characters");
    expect(flat.more).toMatch(/^\d+ records, first: Sector #\d+$/);
    expect(g.issues.filter((c) => c.code.startsWith("PROTECTED"))).toHaveLength(2);
    const w = issueGroups(haunted).warnings;
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ warn: true, code: "WARNING · dim-lights", target: { scope: "MAP01", record: "Sector", index: 39 } });
  });

  it("不在当前地图的问题写出地图名", () => {
    const p: PlanView = { ...careless, issues: [{ ...careless.issues[0]!, locator: { scope: "MAP02", record: "Thing", index: 3 } }] };
    expect(issueGroups(p).issues[0]!.more).toBe("MAP02 Thing #3, field type");
  });

  it("预设载入后的选中：第一个解析成功的 pin，否则第一个有定位的问题", () => {
    expect(initialSelection(haunted)).toEqual({ record: "Sector", index: 0 });
    expect(initialSelection(reloc)).toEqual({ record: "Sector", index: 196 });
    expect(initialSelection(careless)).toEqual({ record: "Thing", index: 0 });
  });
});

describe("记录面板", () => {
  it("haunted-house 的 Sector #0：两个字段改动，字节偏移，改动的字节标粉", () => {
    const plan = session.plan(1, HAUNTED, "MAP01");
    const v = recordView({ record: "Sector", index: 0 }, map01, plan, indexPlan(plan), true, "fixture.wad")!;
    const start = map01.lumps.SECTORS!.offset;
    expect(v.title).toBe("Sector #0");
    expect(v.pill).toEqual({ cls: "ok", text: "2 fields change" });
    expect(v.sub).toBe(`SECTORS record · file bytes ${start}–${start + 25} (0x${start.toString(16).toUpperCase().padStart(6, "0")})`);
    expect(v.rows.find((r) => r.name === "lightlevel")).toEqual({ name: "lightlevel", cls: "changed", cell: { kind: "changed", old: "144", text: "100" } });
    expect(v.rows.find((r) => r.name === "special")!.cell).toEqual({ kind: "changed", old: "0 (none)", text: "1 (light blinks randomly)" });
    const pink = v.hex.rows.flatMap((r) => r.cells).filter((c) => c.cls === "b ch").map((c) => c.text);
    expect(pink).toEqual(["64", "00", "01", "00"]);
    expect(v.hex.label).toBe("Hex · after · fixture.wad");
    // 修改前：同样的字节不标粉，显示原值
    const before = recordView({ record: "Sector", index: 0 }, map01, plan, indexPlan(plan), false, "fixture.wad")!;
    expect(before.hex.rows.flatMap((r) => r.cells).some((c) => c.cls === "b ch")).toBe(false);
    expect(before.rows.find((r) => r.name === "lightlevel")!.cell).toEqual({ kind: "plain", text: "144" });
  });

  it("careless-edit 的 Thing #0：被拦下的字段标红，列出原因卡片", () => {
    const plan = session.plan(2, CARELESS_EDIT, "MAP01");
    const v = recordView({ record: "Thing", index: 0 }, map01, plan, indexPlan(plan), false, "fixture.wad")!;
    expect(v.pill).toEqual({ cls: "bad", text: "blocked" });
    expect(v.rows.find((r) => r.name === "type")).toMatchObject({ cls: "blocked", cell: { kind: "blocked", text: "1 Player 1 start", mark: "  ✕ 3001" } });
    expect(v.reasonsLabel).toBe("Why this record is blocked");
    // 拦截原因在前，警告（Imp 比出生点高）在后
    expect(v.reasons.map((r) => r.code)).toEqual(["PROTECTED · thing-player-start", "PROTECTED · thing-category", "WARNING · thing-size-increase"]);
    expect(v.reasons[0]!.m).not.toMatch(/allowProtected/);
    expect(v.hex.rows.flatMap((r) => r.cells).filter((c) => c.cls === "b bl")).toHaveLength(2);
  });

  it("RELOCATED 的记录标为 relocated", () => {
    const plan = session.plan(3, RELOCATION, "MAP01");
    expect(recordView({ record: "Sector", index: 196 }, map01, plan, indexPlan(plan), true, "f")!.pill).toEqual({ cls: "review", text: "relocated" });
  });

  it("hexRows：前后各 8 字节，Lump 外为 ··，记录外为 out", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i + 0x41);
    const rows = hexRows(100, bytes, 110, 10, new Set([112, 113]), new Set(), true);
    expect(rows.map((r) => r.off.trim())).toEqual(["000060", "000068", "000070", "000078"]);
    expect(rows[0]!.cells.slice(0, 4).map((c) => c.text)).toEqual(["··", "··", "··", "··"]);
    expect(rows[0]!.cells[4]).toEqual({ cls: "b out", text: "41" });
    expect(rows[1]!.cells.slice(6).map((c) => c.cls)).toEqual(["b rb", "b rb"]);
    expect(rows[2]!.cells.slice(0, 2).map((c) => c.cls)).toEqual(["b ch", "b ch"]);
    expect(hexRows(100, bytes, 110, 10, new Set([112]), new Set([112]), false)[2]!.cells[0]!.cls).toBe("b bl");
  });

  it("stripHookNote 去掉位置前缀和 allowProtected 说明", () => {
    expect(stripHookNote("MAP01 Thing #0 type: x is protected (hook thing-key; add it to allowProtected to opt in)")).toBe("x is protected");
  });
});

describe("文件名", () => {
  it("默认名由补丁名生成；回执名与 CLI 默认相同", () => {
    expect(defaultWadName("Haunted House")).toBe("haunted-house.wad");
    expect(patchFileName("Haunted House")).toBe("haunted-house.nhpatch.json");
    expect(defaultWadName("☠")).toBe("patch.wad");
    expect(receiptFileName("haunted-house.wad")).toBe("haunted-house.receipt.json");
  });

  it("用户输入：去掉路径和保留字符、补全 .wad、空名用默认、设备名加下划线", () => {
    const f = (s: string) => exportFileName(s, "x.wad");
    expect(f("my map")).toBe("my map.wad");
    expect(f("My.WAD")).toBe("My.wad");
    expect(f("..\\..\\evil/name")).toBe("-..-evil-name.wad");
    expect(f("a:b*c?")).toBe("a-b-c-.wad");
    expect(f("   ")).toBe("x.wad");
    expect(f(".wad")).toBe("x.wad");
    expect(f("con")).toBe("_con.wad");
    expect(f("name. ")).toBe("name.wad");
  });
});

describe("预设", () => {
  it("包含 patches/haunted-house.nhpatch.json，默认是它", () => {
    expect(BUILTIN_PRESETS[0]!.file).toBe("patches/haunted-house.nhpatch.json");
    expect(BUILTIN_PRESETS[0]!.patch).toEqual(JSON.parse(readFileSync(resolve(REPO, "patches/haunted-house.nhpatch.json"), "utf8")) as Json);
  });
});
