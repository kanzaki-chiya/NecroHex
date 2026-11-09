/**
 * Wad_Record_Source：补丁引擎经 wadAdapter 读写 WAD 记录。
 * 作用域只列 Doom 格式的地图；schema 由 RECORD_LAYOUTS 推导，字段名与 wad.records.yaml 一致。
 * 带写回通道的打开函数不导出，createWadAdapter 把它登记到 core 的写回登记表，只有 revertPatch 能取回。
 * 结构护栏（只检查新写入的值）：字段类型和范围、写入位置、贴图名存在、Thing 类型已知、ceilingheight >= floorheight。
 * 可玩性护栏在 guardrails.ts。
 */
import type {
  FieldKind,
  FieldValue,
  RecordAdapter,
  RecordLocator,
  RecordSchema,
  RecordScope,
  RecordSource,
  Span,
  StructuralCheck,
  WriteOutcome,
  WriteRejection,
} from "@necrohex/core";
import { registerRestorer, type RestorableRecordSource } from "@necrohex/core/internal";
import { encodeField, type FieldLayout } from "./field-codec.ts";
import { RECORD_LAYOUTS, type RecordName } from "./generated/records.ts";
import { WAD_HOOKS, WadHookContext } from "./guardrails.ts";
import { restoreWadField } from "./restore-channel.ts";
import { thingInfo } from "./thing-types.ts";
import { WadFile, WadRecordError, type MapScope } from "./wad.ts";

const WRITABLE: ReadonlySet<string> = new Set(["Sector", "Thing"]);

function deriveSchema(): RecordSchema {
  const out: Record<string, { writable: boolean; fields: Record<string, FieldKind> }> = {};
  for (const [name, layout] of Object.entries(RECORD_LAYOUTS)) {
    const fields: Record<string, FieldKind> = {};
    for (const [f, l] of Object.entries(layout.fields as Record<string, FieldLayout>)) {
      fields[f] = l.count !== 1 ? "other" : l.type === "name8" ? "name" : "int";
    }
    out[name] = Object.freeze({ writable: WRITABLE.has(name), fields: Object.freeze(fields) });
  }
  return Object.freeze(out);
}

const SCHEMA = deriveSchema();

function layoutOf(record: string, field: string): FieldLayout {
  if (!Object.hasOwn(RECORD_LAYOUTS, record)) throw new RangeError(`unknown record type ${record}`);
  const fields = RECORD_LAYOUTS[record as RecordName].fields as Record<string, FieldLayout>;
  if (!Object.hasOwn(fields, field)) throw new RangeError(`${record} has no field ${field}`);
  return fields[field]!;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 写入失败转成 WriteOutcome：WadRecordError 用它的 code，编码和参数错误为 ENCODE，只读记录为 READ_ONLY。 */
function failure(e: unknown): WriteOutcome {
  if (e instanceof WadRecordError) return { ok: false, reason: e.code, message: e.message };
  if (e instanceof TypeError || e instanceof RangeError) return { ok: false, reason: "ENCODE", message: e.message };
  if (e instanceof Error) return { ok: false, reason: "READ_ONLY", message: e.message };
  throw e;
}

interface Located {
  readonly lump: number;
  readonly record: RecordName;
  readonly span: Span;
}

/** 只把 ASCII a–z 转大写。原版引擎查找 Flat 名时同样不区分大小写。 */
function asciiUpper(s: string): string {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}

const FLAT_START = /^F{1,2}_START$/;
const FLAT_END = /^F{1,2}_END$/;

/** F_START/F_END（PWAD 中也常用 FF_START/FF_END）之间的非标记 Lump 名，大写。嵌套的 F1_START 等标记本身不算 Flat。 */
export function flatNames(wad: WadFile): Set<string> {
  const out = new Set<string>();
  let depth = 0;
  for (const l of wad.lumps) {
    const name = asciiUpper(l.name);
    if (FLAT_START.test(name)) depth++;
    else if (FLAT_END.test(name)) depth = Math.max(0, depth - 1);
    else if (depth > 0 && !(l.isMarker && /_(START|END)$/.test(name))) out.add(name);
  }
  return out;
}

const STRUCTURAL_CHECKS: readonly StructuralCheck[] = Object.freeze([
  Object.freeze({
    name: "field-value",
    description: "new values have the field's type and range; names are 1 to 8 printable ASCII characters",
    reasons: Object.freeze(["ENCODE"]),
  }),
  Object.freeze({
    name: "write-target",
    description: "writes land inside a recognized Doom-format map and do not overlap the header, directory or other lumps",
    reasons: Object.freeze(["READ_ONLY", "OUTSIDE_MAP_SCOPE", "WRITE_OVERLAPS_STRUCTURE", "UNSUPPORTED_MAP_FORMAT"]),
  }),
  Object.freeze({
    name: "flat-exists",
    description: "new floorpic and ceilingpic names are flats in this WAD or in the given base IWAD",
    reasons: Object.freeze(["UNKNOWN_FLAT"]),
  }),
  Object.freeze({
    name: "thing-type-known",
    description: "new Thing types are known Doom or Doom II types",
    reasons: Object.freeze(["UNKNOWN_THING_TYPE"]),
  }),
  Object.freeze({
    name: "sector-heights",
    description: "a sector whose height is written keeps ceilingheight >= floorheight",
    reasons: Object.freeze(["CEILING_BELOW_FLOOR"]),
  }),
]);

interface BuildOptions {
  /** 基础 IWAD 中的 Flat 名（大写）。 */
  readonly baseFlats: ReadonlySet<string>;
  readonly hasBase: boolean;
}

function build(input: Uint8Array, options: BuildOptions): { source: RecordSource; restore: RestorableRecordSource["restoreField"] } {
  const wad = WadFile.parse(new Uint8Array(input));
  const ownFlats = flatNames(wad);
  const doom = wad.maps.filter((m) => m.format === "doom");
  const count = new Map<string, number>();
  for (const m of doom) count.set(m.name.toUpperCase(), (count.get(m.name.toUpperCase()) ?? 0) + 1);
  const byId = new Map<string, MapScope>();
  const scopes: RecordScope[] = doom.map((m) => {
    const id = count.get(m.name.toUpperCase())! > 1 ? `${m.name}@${m.markerIndex}` : m.name;
    byId.set(id, m);
    return Object.freeze({ id, name: m.name });
  });

  const scopeOf = (id: string): MapScope => {
    const m = byId.get(id);
    if (!m) throw new RangeError(`no scope ${id}`);
    return m;
  };
  const lumpOf = (scope: string, record: string): number | undefined => {
    if (!Object.hasOwn(RECORD_LAYOUTS, record)) throw new RangeError(`unknown record type ${record}`);
    return scopeOf(scope).lumps[RECORD_LAYOUTS[record as RecordName].lump];
  };
  const locate = (loc: RecordLocator, field: string): Located => {
    layoutOf(loc.record, field);
    const lump = lumpOf(loc.scope, loc.record);
    if (lump === undefined) throw new RangeError(`${loc.scope} has no ${RECORD_LAYOUTS[loc.record as RecordName].lump} lump`);
    const record = loc.record as RecordName;
    return { lump, record, span: wad.fieldSpan(lump, record, loc.index, field as never) };
  };
  const current = (at: Located): Uint8Array => {
    const lump = wad.lumps[at.lump]!;
    const offset = at.span.start - lump.dataSpan!.start;
    return wad.lumpBytes(at.lump).subarray(offset, offset + (at.span.end - at.span.start));
  };
  const write = (loc: RecordLocator, field: string, doWrite: (at: Located) => Span): WriteOutcome => {
    const at = locate(loc, field);
    const before = current(at);
    let span: Span;
    try {
      span = doWrite(at);
    } catch (e) {
      return failure(e);
    }
    return { ok: true, span, unchanged: equal(before, current(at)) };
  };

  /**
   * 引用完整性：只检查会改变字节的新值。编码失败留给 setField 报告；与当前字节相同的写入不是新值，不检查。
   */
  const checkReference = (loc: RecordLocator, field: string, value: FieldValue): WriteOutcome | null => {
    const isFlat = loc.record === "Sector" && (field === "floorpic" || field === "ceilingpic");
    const isType = loc.record === "Thing" && field === "type";
    if (!isFlat && !isType) return null;
    let encoded: Uint8Array;
    try {
      encoded = encodeField(layoutOf(loc.record, field), `${loc.record}.${field}`, value);
      if (equal(encoded, current(locate(loc, field)))) return null;
    } catch {
      return null;
    }
    if (isFlat) {
      const name = asciiUpper(value as string);
      if (ownFlats.has(name) || options.baseFlats.has(name)) return null;
      const where = options.hasBase ? "this WAD or the base IWAD" : "this WAD (no base IWAD was given)";
      return { ok: false, reason: "UNKNOWN_FLAT", message: `flat ${JSON.stringify(value)} does not exist in ${where}` };
    }
    if (thingInfo(value as number)) return null;
    return { ok: false, reason: "UNKNOWN_THING_TYPE", message: `Thing type ${String(value)} is not a known Doom or Doom II type` };
  };

  const checkWrites: NonNullable<RecordSource["checkWrites"]> = (written) => {
    const out: WriteRejection[] = [];
    const seen = new Set<string>();
    for (const w of written) {
      if (w.unchanged || w.locator.record !== "Sector" || (w.field !== "floorheight" && w.field !== "ceilingheight")) continue;
      const loc = { scope: w.locator.scope, record: "Sector", index: w.locator.index };
      const key = `${loc.scope}\u0000${loc.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const floor = source.readField(loc, "floorheight") as number;
      const ceiling = source.readField(loc, "ceilingheight") as number;
      if (ceiling >= floor) continue;
      // 每个实际改变的高度字段各报一条，拒绝落在补丁写入的字段上
      for (const f of ["floorheight", "ceilingheight"]) {
        if (!written.some((x) => !x.unchanged && x.field === f && x.locator.scope === loc.scope && x.locator.record === "Sector" && x.locator.index === loc.index)) continue;
        out.push({
          locator: loc,
          field: f,
          reason: "CEILING_BELOW_FLOOR",
          message: `after the patch ceilingheight ${ceiling} would be below floorheight ${floor}`,
        });
      }
    }
    return out;
  };

  const source: RecordSource = {
    schema: SCHEMA,
    structuralChecks: STRUCTURAL_CHECKS,
    hookContext: new WadHookContext(wad, byId),
    checkWrites,
    scopes: () => scopes,
    recordCount: (scope, record) => {
      const lump = lumpOf(scope, record);
      return lump === undefined ? 0 : wad.recordCount(lump, record as RecordName);
    },
    readField: (loc, field): FieldValue => {
      const layout = layoutOf(loc.record, field);
      if (layout.count !== 1) throw new TypeError(`${loc.record}.${field} is not a single value`);
      const at = locate(loc, field);
      const value = (wad.readRecord(at.lump, at.record, loc.index) as unknown as Record<string, FieldValue>)[field]!;
      return value;
    },
    fieldSpan: (loc, field) => locate(loc, field).span,
    canRestore: (loc, field) => {
      if (layoutOf(loc.record, field).type !== "name8") return true;
      const raw = current(locate(loc, field));
      const nul = raw.indexOf(0);
      return nul < 0 || raw.subarray(nul).every((b) => b === 0);
    },
    writeField: (loc, field, value) =>
      checkReference(loc, field, value) ?? write(loc, field, (at) => wad.setField(at.lump, at.record, loc.index, field as never, value as never)),
    serialize: () => wad.serialize(),
  };
  const restore = (loc: RecordLocator, field: string, value: FieldValue): WriteOutcome =>
    write(loc, field, (at) => restoreWadField(wad, at.lump, at.record, loc.index, field, value));
  return { source, restore };
}

export interface WadAdapterOptions {
  /**
   * 基础 IWAD 的字节，例如 freedoom2.wad。PWAD 通常不带 Flat，新贴图名要在这里查找。
   * 只读取其中的 Flat 名；补丁不会写入它。
   */
  readonly baseIwad?: Uint8Array;
}

/**
 * 创建 WAD adapter。不给 baseIwad 时，新贴图名只能使用当前 WAD 自带的 Flat。
 * 每个 adapter 各自登记写回通道，所以 revertPatch 要用应用补丁时的同一个（或任一个由本函数创建的）adapter。
 */
export function createWadAdapter(options: WadAdapterOptions = {}): RecordAdapter {
  const baseFlats: ReadonlySet<string> = options.baseIwad ? flatNames(WadFile.parse(options.baseIwad)) : new Set();
  const opts: BuildOptions = { baseFlats, hasBase: options.baseIwad !== undefined };
  const adapter: RecordAdapter = Object.freeze({
    format: "wad",
    hooks: WAD_HOOKS,
    open(input: Uint8Array): RecordSource {
      return build(input, opts).source;
    },
  });
  registerRestorer(adapter, (input: Uint8Array): RestorableRecordSource => {
    // 撤销只写回旧值，不需要基础 IWAD
    const { source, restore } = build(input, opts);
    return { ...source, restoreField: restore };
  });
  return adapter;
}

/** 不带基础 IWAD 的 adapter。 */
export const wadAdapter: RecordAdapter = createWadAdapter();
