/**
 * 工作台的状态逻辑，全部是纯函数，逐个对应 Mockup 脚本里的 renderPatch、renderMap、renderRecord、renderEditor、opControl、loadPreset。
 * 只做显示整理和补丁 JSON 的编辑；补丁能否写入、改什么、为什么被拒绝都来自 Planner_Worker 里引擎的结果（PlanView）。
 */
import { readSector, readThing, SectorLayout, ThingLayout, fieldByteLength, type FieldLayout, type SectorFingerprint } from "@necrohex/adapter-wad";
import { hexOf, SPECIAL, typeName } from "./constants.ts";
import type { ChangeView, IssueView, MapData, PinView, PlanView, ReceiptView } from "../worker/protocol.ts";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };
export type RecordKind = "Sector" | "Thing";

export interface Sel {
  readonly record: RecordKind;
  readonly index: number;
}

export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
export const clone = <T extends Json>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// ---------------------------------------------------------------------------
// 补丁 JSON

export interface OpLike {
  readonly id: string;
  readonly select: JsonObject;
  readonly change: JsonObject;
}

/** 补丁里能显示的操作。导入的补丁可能不合法，这里只取出形状像操作的项，合法性由引擎判断。 */
export function operationsOf(patch: Json): OpLike[] {
  if (!isObject(patch) || !Array.isArray(patch["operations"])) return [];
  return patch["operations"].flatMap((o, n) =>
    isObject(o) ? [{ id: typeof o["id"] === "string" ? o["id"] : `#${n}`, select: isObject(o["select"]) ? o["select"] : {}, change: isObject(o["change"]) ? o["change"] : {} }] : [],
  );
}

export function patchName(patch: Json): string {
  return isObject(patch) && typeof patch["name"] === "string" ? patch["name"] : "patch";
}

export function targetMaps(patch: Json): "*" | string[] {
  const t = isObject(patch) ? patch["target"] : undefined;
  const maps = isObject(t) ? t["maps"] : undefined;
  if (maps === "*") return "*";
  return Array.isArray(maps) ? maps.filter((m): m is string => typeof m === "string") : [];
}

/** 交给引擎的补丁：去掉被关闭的操作。 */
export function activePatch(patch: Json, off: ReadonlySet<string>): Json {
  const p = clone(patch);
  if (isObject(p) && Array.isArray(p["operations"])) {
    p["operations"] = p["operations"].filter((o) => !(isObject(o) && typeof o["id"] === "string" && off.has(o["id"])));
  }
  return p;
}

export function isEdited(patch: Json, original: Json, off: ReadonlySet<string>): boolean {
  return JSON.stringify(patch) !== JSON.stringify(original) || off.size > 0;
}

function editOps(patch: Json, f: (ops: Json[]) => Json[]): Json {
  const p = clone(patch);
  if (isObject(p) && Array.isArray(p["operations"])) p["operations"] = f(p["operations"]);
  return p;
}

/** 改一个操作的一个算子参数（数值控件）。 */
export function setChangeParam(patch: Json, opId: string, field: string, key: "set" | "scale", value: Json): Json {
  return editOps(patch, (ops) =>
    ops.map((o) => {
      if (!isObject(o) || o["id"] !== opId || !isObject(o["change"])) return o;
      const ch = o["change"][field];
      if (isObject(ch)) ch[key] = value;
      return o;
    }),
  );
}

export function removeOperation(patch: Json, opId: string): Json {
  return editOps(patch, (ops) => ops.filter((o) => !(isObject(o) && o["id"] === opId)));
}

/** 加入或替换一个操作；操作所在的地图不在 target.maps 里时加进去（"*" 不变）。 */
export function upsertOperation(patch: Json, op: JsonObject, mapName: string): Json {
  const p = editOps(patch, (ops) => [...ops.filter((o) => !(isObject(o) && o["id"] === op["id"])), op]);
  if (isObject(p) && isObject(p["target"]) && Array.isArray(p["target"]["maps"])) {
    const maps = p["target"]["maps"];
    if (!maps.some((m) => typeof m === "string" && m.toUpperCase() === mapName.toUpperCase())) maps.push(mapName);
  }
  return p;
}

// ---------------------------------------------------------------------------
// 数值控件（Mockup 的 opControl）

export type OpControl =
  | { readonly kind: "scale"; readonly field: string; readonly value: number; readonly clamp: readonly [number, number] | null }
  | { readonly kind: "special"; readonly field: string; readonly value: number }
  | { readonly kind: "text" | "number"; readonly field: string; readonly value: string; readonly list: "flatlist" | "typelist" | null; readonly hint: string };

export function opControl(op: OpLike): OpControl | null {
  const entries = Object.entries(op.change);
  if (entries.length !== 1 || "pin" in op.select) return null;
  const [field, ch] = entries[0]!;
  if (!isObject(ch)) return null;
  if ("scale" in ch && typeof ch["scale"] === "number") {
    const c = ch["clamp"];
    const clamp = Array.isArray(c) && c.length === 2 && typeof c[0] === "number" && typeof c[1] === "number" ? ([c[0], c[1]] as const) : null;
    return { kind: "scale", field, value: ch["scale"], clamp };
  }
  if ("set" in ch) {
    const v = ch["set"];
    if (field === "special" && typeof v === "number") return { kind: "special", field, value: v };
    const isName = typeof v === "string";
    return {
      kind: isName ? "text" : "number",
      field,
      value: String(v),
      list: isName ? "flatlist" : field === "type" ? "typelist" : null,
      hint: field === "type" && typeof v === "number" ? typeName(v) : "",
    };
  }
  return null;
}

/** 控件输入转成新值：名称去掉首尾空白，其余按数字。 */
export function controlValue(c: OpControl, raw: string): Json {
  return c.kind === "text" ? raw.trim() : Number(raw);
}

// ---------------------------------------------------------------------------
// 按记录索引规划结果

export const recKey = (record: string, index: number) => `${record}#${index}`;

export interface PlanIndex {
  readonly byKey: ReadonlyMap<string, readonly ChangeView[]>;
  readonly blocked: ReadonlyMap<string, readonly IssueView[]>;
  readonly relocOps: ReadonlySet<string>;
}

export function indexPlan(plan: PlanView): PlanIndex {
  const byKey = new Map<string, ChangeView[]>();
  const blocked = new Map<string, IssueView[]>();
  const add = <T>(m: Map<string, T[]>, k: string, v: T) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const c of plan.changes) add(byKey, recKey(c.record, c.index), c);
  for (const i of plan.issues) if (i.locator && i.locator.scope === plan.scope) add(blocked, recKey(i.locator.record, i.locator.index), i);
  return { byKey, blocked, relocOps: new Set(plan.pins.filter((p) => p.result === "RELOCATED").map((p) => p.op)) };
}

/** 作用域 id 去掉 @markerIndex 后的地图名。 */
export const scopeName = (scope: string) => scope.split("@")[0]!;

// ---------------------------------------------------------------------------
// 补丁面板

export interface VerdictView {
  readonly ok: boolean;
  readonly big: string;
  readonly note: string;
  readonly hash: string | null;
  readonly warn: string | null;
}

export function verdictView(plan: PlanView, patch: Json, mapName: string, edited: boolean, receipt: ReceiptView | null): VerdictView {
  if (plan.ok) {
    const n = plan.changes.length;
    const t = targetMaps(patch);
    const listed = t === "*" ? [] : t;
    const changed = Object.keys(plan.changedByScope).map(scopeName);
    const other = [...new Set([...listed, ...changed].filter((m) => m.toUpperCase() !== mapName.toUpperCase()))];
    const w = plan.warnings.length;
    return {
      ok: true,
      big: n ? `Ready: ${n} fields change in ${mapName}` : `Ready: nothing changes in ${mapName}`,
      note: `Every other byte stays as it is.${other.length ? ` The patch also targets ${other.join(", ")}, not shown here.` : ""}`,
      hash: !edited && receipt?.ok && receipt.outputHash ? `receipt out ${receipt.outputHash.slice(0, 23)}…` : null,
      warn: w ? `${w} warning${w > 1 ? "s" : ""} below` : null,
    };
  }
  const k = plan.issues.length;
  return { ok: false, big: `Rejected: ${k} problem${k > 1 ? "s" : ""}`, note: "Nothing would be written. Fix or switch off the red operations.", hash: null, warn: null };
}

export interface PinCard {
  readonly op: string;
  readonly pill: "bad" | "review" | "exact";
  readonly pillText: string;
  readonly from: string;
  readonly to: string;
  readonly msg: string;
  readonly target: { readonly scope: string | null; readonly index: number };
}

export function pinCards(pins: readonly PinView[]): PinCard[] {
  return pins.map((pn) => {
    const reloc = pn.result === "RELOCATED";
    const bad = pn.index === null;
    return {
      op: pn.op,
      pill: bad ? "bad" : reloc ? "review" : "exact",
      pillText: bad ? pn.result.toLowerCase().replace("_", " ") : reloc ? "relocated · review" : "exact",
      from: `#${pn.expectedIndex}`,
      to: bad ? "?" : `#${pn.index}`,
      msg: bad
        ? "No single sector matches the fingerprint, so the patch refuses to guess."
        : reloc
          ? `Sector #${pn.expectedIndex} has moved in this map version. One sector matches the fingerprint (score ${pn.score}). The dashed outline marks the old index.`
          : pn.fingerprintChecked
            ? `The fingerprint matches at the expected index (score ${pn.score}).`
            : "Selected by index only. The pin has no fingerprint, so nothing was verified.",
      target: { scope: pn.scope, index: bad ? pn.expectedIndex : pn.index! },
    };
  });
}

export interface OpRow {
  readonly id: string;
  readonly off: boolean;
  readonly blocked: number;
  readonly count: string;
  readonly user: boolean;
  readonly focused: boolean;
  readonly control: OpControl | null;
}

export function opRows(patch: Json, off: ReadonlySet<string>, plan: PlanView | null, focus: string | null): OpRow[] {
  const counts = new Map<string, Set<string>>();
  const blockedOps = new Map<string, number>();
  for (const c of plan?.changes ?? []) {
    const s = counts.get(c.op) ?? new Set<string>();
    s.add(recKey(c.record, c.index));
    counts.set(c.op, s);
  }
  for (const i of plan?.issues ?? []) for (const op of i.ops.length ? i.ops : i.op ? [i.op] : []) blockedOps.set(op, (blockedOps.get(op) ?? 0) + 1);
  return operationsOf(patch).map((o) => {
    const isOff = off.has(o.id);
    const nb = blockedOps.get(o.id) ?? 0;
    const n = counts.get(o.id)?.size ?? 0;
    return {
      id: o.id,
      off: isOff,
      blocked: nb,
      count: isOff ? "off" : nb ? `${nb} blocked` : String(n),
      user: o.id.startsWith("edit-"),
      focused: focus === o.id,
      control: isOff ? null : opControl(o),
    };
  });
}

/** 去掉消息开头的“作用域 记录 #下标 字段: ”。 */
export const stripLocation = (m: string) => m.replace(/^\S+ \w+ #\d+ \w+: /, "");
/** 再去掉 PROTECTED 消息结尾的钩子说明（记录面板用）。 */
export const stripHookNote = (m: string) => stripLocation(m).replace(/ \(hook [\w-]+; add it to allowProtected to opt in\)$/, "");

export interface IssueCardView {
  readonly warn: boolean;
  readonly code: string;
  readonly m: string;
  readonly more: string;
  /** 点击后选中的记录；没有定位的问题为 null。 */
  readonly target: { readonly scope: string; readonly record: RecordKind; readonly index: number } | null;
}

function where(i: IssueView, scope: string): string {
  if (!i.locator) return "";
  const map = i.locator.scope === scope ? "" : `${scopeName(i.locator.scope)} `;
  return `${map}${i.locator.record} #${i.locator.index}`;
}

function targetOf(i: IssueView): IssueCardView["target"] {
  const l = i.locator;
  return l && (l.record === "Sector" || l.record === "Thing") ? { scope: l.scope, record: l.record, index: l.index } : null;
}

/** 原因和警告按 Mockup 的规则分组：同一操作、同一问题、同一说明的记录合成一张卡片。 */
export function issueGroups(plan: PlanView): { readonly issues: IssueCardView[]; readonly warnings: IssueCardView[] } {
  const group = (list: readonly IssueView[], key: (i: IssueView) => string) => {
    const m = new Map<string, IssueView[]>();
    for (const i of list) {
      const k = key(i);
      const g = m.get(k);
      if (g) g.push(i);
      else m.set(k, [i]);
    }
    return [...m.values()];
  };
  const card = (g: readonly IssueView[], warn: boolean): IssueCardView => {
    const i = g[0]!;
    const op = i.op ?? "patch";
    const more = !i.locator
      ? i.path
        ? `at ${i.path}`
        : ""
      : g.length > 1
        ? `${g.length} records, first: ${where(i, plan.scope)}`
        : `${where(i, plan.scope)}${i.field ? `, field ${i.field}` : ""}`;
    return { warn, code: warn ? `WARNING · ${op}` : `${i.code} · ${op}`, m: stripLocation(i.message), more, target: targetOf(i) };
  };
  return {
    issues: group(plan.issues, (i) => `${i.op}|${i.code}|${stripLocation(i.message)}`).map((g) => card(g, false)),
    warnings: group(plan.warnings, (w) => `${w.op}|${w.hook}`).map((g) => card(g, true)),
  };
}

// ---------------------------------------------------------------------------
// 记录面板

interface FieldDef {
  readonly name: string;
  readonly offset: number;
  readonly length: number;
}

const fieldsOf = (layout: { readonly fields: Readonly<Record<string, FieldLayout>> }): FieldDef[] =>
  Object.entries(layout.fields).map(([name, f]) => ({ name, offset: f.offset, length: fieldByteLength(f) }));

export const LAYOUT: Readonly<Record<RecordKind, { readonly lump: "SECTORS" | "THINGS"; readonly size: number; readonly fields: readonly FieldDef[] }>> = {
  Sector: { lump: "SECTORS", size: SectorLayout.size, fields: fieldsOf(SectorLayout) },
  Thing: { lump: "THINGS", size: ThingLayout.size, fields: fieldsOf(ThingLayout) },
};

/** 用 adapter-wad 生成的读取函数解码一条记录。 */
export function decodeRecord(record: RecordKind, bytes: Uint8Array, index: number): Record<string, number | string> {
  const size = LAYOUT[record].size;
  const view = new DataView(bytes.buffer, bytes.byteOffset + index * size, size);
  return (record === "Sector" ? readSector(view, 0) : readThing(view, 0)) as unknown as Record<string, number | string>;
}

export function recordCount(map: MapData, record: RecordKind): number {
  const l = map.lumps[LAYOUT[record].lump];
  return l ? Math.floor(l.bytes.length / LAYOUT[record].size) : 0;
}

export function formatValue(record: RecordKind, name: string, val: number | string): string {
  if (record === "Thing" && name === "type") return `${val} ${typeName(Number(val))}`;
  if (name === "special") return `${val} (${SPECIAL[Number(val)] ?? "?"})`;
  return String(val);
}

export type FieldCell =
  | { readonly kind: "plain"; readonly text: string }
  | { readonly kind: "blocked"; readonly text: string; readonly mark: string }
  | { readonly kind: "changed"; readonly old: string; readonly text: string }
  | { readonly kind: "pending"; readonly text: string; readonly note: string };

export interface FieldRow {
  readonly name: string;
  readonly cls: "" | "changed" | "blocked";
  readonly cell: FieldCell;
}

export interface ReasonCard {
  readonly warn: boolean;
  readonly code: string;
  readonly m: string;
  readonly more: string;
}

export interface RecordView {
  readonly title: string;
  readonly pill: { readonly cls: string; readonly text: string };
  readonly sub: string;
  readonly rows: readonly FieldRow[];
  readonly by: string | null;
  readonly reasonsLabel: string | null;
  readonly reasons: readonly ReasonCard[];
  readonly reasonNote: string | null;
  readonly hex: HexView;
}

export interface HexCell {
  readonly cls: string;
  readonly text: string;
}

export interface HexRow {
  readonly off: string;
  readonly cells: readonly HexCell[];
  readonly asc: string;
}

export interface HexView {
  readonly label: string;
  readonly rows: readonly HexRow[];
  readonly note: string;
}

/**
 * 记录前后各 8 字节，按 8 字节一行。lumpOffset 是 Lump 数据在文件里的偏移，bytes 是整个 Lump。
 * 改动的字节（只在显示修改后时）标 ch，被拦下字段的字节标 bl，记录外的字节标 out。
 */
export function hexRows(lumpOffset: number, bytes: Uint8Array, recStart: number, size: number, changedAt: ReadonlySet<number>, blockedAt: ReadonlySet<number>, showAfter: boolean): HexRow[] {
  const W = 8;
  const from = Math.floor((recStart - W) / W) * W;
  const to = Math.ceil((recStart + size + W) / W) * W;
  const rows: HexRow[] = [];
  for (let row = from; row < to; row += W) {
    const cells: HexCell[] = [];
    let asc = "";
    for (let a = row; a < row + W; a++) {
      const rel = a - lumpOffset;
      const byte = rel >= 0 && rel < bytes.length ? bytes[rel]! : null;
      let cls = a >= recStart && a < recStart + size ? "b rb" : "b out";
      if (changedAt.has(a) && showAfter) cls = "b ch";
      if (blockedAt.has(a)) cls = "b bl";
      cells.push({ cls, text: byte === null ? "··" : hexOf(byte, 2) });
      asc += byte === null ? " " : byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".";
    }
    rows.push({ off: hexOf(row, 6) + "  ", cells, asc: " " + asc });
  }
  return rows;
}

export function recordView(sel: Sel, map: MapData, plan: PlanView, index: PlanIndex, showAfter: boolean, fileName: string): RecordView | null {
  const L = LAYOUT[sel.record];
  const lump = map.lumps[L.lump];
  if (!lump || sel.index < 0 || sel.index >= recordCount(map, sel.record)) return null;
  const afterBytes = plan.ok ? plan.after?.[L.lump] ?? null : null;
  const before = decodeRecord(sel.record, lump.bytes, sel.index);
  const after = afterBytes ? decodeRecord(sel.record, afterBytes, sel.index) : before;
  const k = recKey(sel.record, sel.index);
  const cs = index.byKey.get(k) ?? [];
  const bl = index.blocked.get(k) ?? [];
  const recStart = lump.offset + sel.index * L.size;
  const fmt = (name: string, v: number | string) => formatValue(sel.record, name, v);

  const rows: FieldRow[] = L.fields.map(({ name }) => {
    const c = cs.find((x) => x.field === name);
    const b = bl.find((x) => x.field === name);
    if (b) return { name, cls: "blocked", cell: { kind: "blocked", text: fmt(name, before[name]!), mark: `  ✕ ${c ? c.newValue : "blocked"}` } };
    if (c && showAfter) return { name, cls: "changed", cell: { kind: "changed", old: fmt(name, before[name]!), text: fmt(name, after[name]!) } };
    if (c && !plan.ok) return { name, cls: "", cell: { kind: "pending", text: fmt(name, before[name]!), note: `  → ${c.newValue} (not written)` } };
    return { name, cls: "", cell: { kind: "plain", text: fmt(name, before[name]!) } };
  });

  const reloc = cs.some((c) => c.kind === "RELOCATED");
  const ops = [...new Set([...cs.map((c) => c.op), ...bl.flatMap((b) => (b.op ? [b.op] : []))])];
  const warns = plan.warnings.filter((w) => w.locator?.scope === plan.scope && w.locator.record === sel.record && w.locator.index === sel.index);
  const reasonCard = (i: IssueView, warn: boolean): ReasonCard => ({
    warn,
    code: warn ? `WARNING · ${i.hook}` : `${i.code}${i.hook ? ` · ${i.hook}` : i.reason ? ` · ${i.reason}` : ""}`,
    m: stripHookNote(i.message),
    more: `operation ${i.op ?? "?"}${i.field ? `, field ${i.field}` : ""}`,
  });
  const hasReasons = bl.length > 0 || warns.length > 0;

  const changedAt = new Set<number>();
  const blockedAt = new Set<number>();
  const mark = (field: string, set: Set<number>) => {
    const f = L.fields.find((x) => x.name === field);
    if (f) for (let i = 0; i < f.length; i++) set.add(recStart + f.offset + i);
  };
  for (const c of cs) mark(c.field, changedAt);
  for (const b of bl) if (b.field) mark(b.field, blockedAt);
  const hexBytes = showAfter && afterBytes ? afterBytes : lump.bytes;
  const note = bl.length
    ? "Red bytes would have been written. The guardrail stops the whole patch."
    : cs.length && plan.ok
      ? showAfter
        ? "Pink bytes are the receipt spans for this record. Switch the map to Before to see the original bytes."
        : "Original bytes. Switch the map to After to see the patched spans."
      : cs.length
        ? "The patch is rejected elsewhere, so these bytes are not written."
        : "This record is not touched by the patch.";

  return {
    title: `${sel.record} #${sel.index}`,
    pill: reloc
      ? { cls: "review", text: "relocated" }
      : bl.length
        ? { cls: "bad", text: "blocked" }
        : cs.length
          ? { cls: "ok", text: `${cs.length} field${cs.length > 1 ? "s" : ""} change` }
          : { cls: "exact", text: "unchanged" },
    sub: `${L.lump} record · file bytes ${recStart}–${recStart + L.size - 1} (0x${hexOf(recStart, 6)})`,
    rows,
    by: ops.length ? `by ${ops.join(", ")}` : null,
    reasonsLabel: hasReasons ? (bl.length ? "Why this record is blocked" : "Warnings for this record") : null,
    reasons: hasReasons ? [...bl.map((i) => reasonCard(i, false)), ...warns.map((w) => reasonCard(w, true))] : [],
    reasonNote: !hasReasons && !plan.ok && cs.length ? "This record passes its checks, but the patch is rejected elsewhere, so nothing is written." : null,
    hex: {
      label: `Hex · ${showAfter ? "after" : "before"} · ${fileName}`,
      rows: hexRows(lump.offset, hexBytes, recStart, L.size, changedAt, blockedAt, showAfter),
      note,
    },
  };
}

// ---------------------------------------------------------------------------
// 编辑器（Mockup 的 renderEditor）

export const EDITOR_FIELDS: Readonly<Record<RecordKind, readonly string[]>> = {
  Sector: ["floorpic", "ceilingpic", "lightlevel", "special"],
  Thing: ["type"],
};

export const userOpId = (sel: Sel) => `edit-${sel.record.toLowerCase()}-${sel.index}`;

/** 编辑器里每个字段的初始值：补丁里已有的 edit 操作的 set 值，否则是记录的输入值。 */
export function editorValues(patch: Json, sel: Sel, base: Readonly<Record<string, number | string>>): Record<string, string> {
  const existing = operationsOf(patch).find((o) => o.id === userOpId(sel));
  const out: Record<string, string> = {};
  for (const f of EDITOR_FIELDS[sel.record]) {
    const ch = existing?.change[f];
    out[f] = String(isObject(ch) && "set" in ch ? ch["set"] : base[f]);
  }
  return out;
}

/**
 * 按编辑器的输入生成操作；没有任何字段与输入值不同时为 null。
 * 扇区：带 map、expectedIndex 和指纹的 pin。Thing：按坐标和类型 where 选中。
 */
export function editorOperation(
  sel: Sel,
  base: Readonly<Record<string, number | string>>,
  values: Readonly<Record<string, string>>,
  mapName: string,
  fingerprint: SectorFingerprint | undefined,
): JsonObject | null {
  const change: JsonObject = {};
  for (const f of EDITOR_FIELDS[sel.record]) {
    const raw = values[f] ?? String(base[f]);
    const val: Json = f === "floorpic" || f === "ceilingpic" ? raw.trim() : Number(raw);
    if (String(val) !== String(base[f])) change[f] = { set: val };
  }
  if (Object.keys(change).length === 0) return null;
  const select: JsonObject =
    sel.record === "Sector"
      ? { record: "Sector", pin: { map: mapName, expectedIndex: sel.index, ...(fingerprint ? { fingerprint: clone(fingerprint as unknown as Json) } : {}) } }
      : { record: "Thing", where: { x: { eq: base["x"]! }, y: { eq: base["y"]! }, type: { eq: base["type"]! } } };
  return { id: userOpId(sel), select, change };
}

// ---------------------------------------------------------------------------
// 预设加载后的选中（Mockup 的 loadPreset）

export function initialSelection(plan: PlanView): Sel | null {
  const pin = plan.pins.find((p) => p.index !== null && p.scope === plan.scope);
  if (pin) return { record: "Sector", index: pin.index! };
  const issue = plan.issues.find((i) => i.locator && i.locator.scope === plan.scope && (i.locator.record === "Sector" || i.locator.record === "Thing"));
  return issue ? { record: issue.locator!.record as RecordKind, index: issue.locator!.index } : null;
}

// ---------------------------------------------------------------------------
// 文件名

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "patch";

export const defaultWadName = (name: string) => `${slug(name)}.wad`;
export const patchFileName = (name: string) => `${slug(name)}.nhpatch.json`;
/** 与 CLI 的默认回执名相同：去掉 .wad，加 .receipt.json。 */
export const receiptFileName = (wadName: string) => `${wadName.replace(/\.wad$/i, "")}.receipt.json`;

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * 用户输入的导出文件名：去掉路径分隔符、保留字符和控制字符，去掉开头的点和结尾的点或空格，
 * 补全 .wad；结果为空时用 fallback；Windows 设备名前加下划线。
 */
export function exportFileName(raw: string, fallback: string): string {
  let s = raw.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-").trim();
  s = s.replace(/[. ]+$/, "");
  if (s.toLowerCase().endsWith(".wad")) s = s.slice(0, -4);
  s = s.replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (!s) return fallback;
  if (RESERVED.test(s.split(".")[0]!)) s = `_${s}`;
  return `${s.slice(0, 120)}.wad`;
}
