/**
 * Wad_Record_Source：补丁引擎经 wadAdapter 读写 WAD 记录。
 * 作用域只列 Doom 格式的地图；schema 由 RECORD_LAYOUTS 推导，字段名与 wad.records.yaml 一致。
 * openRestorable（带写回通道）不导出，模块末尾登记到 core 的写回登记表，只有 revertPatch 能取回。
 */
import type {
  FieldKind,
  FieldValue,
  ProtectionHook,
  RecordAdapter,
  RecordLocator,
  RecordSchema,
  RecordScope,
  RecordSource,
  Span,
  WriteOutcome,
} from "@necrohex/core";
import { registerRestorer, type RestorableRecordSource } from "@necrohex/core/internal";
import type { FieldLayout } from "./field-codec.ts";
import { RECORD_LAYOUTS, type RecordName } from "./generated/records.ts";
import { restoreWadField } from "./restore-channel.ts";
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

function build(input: Uint8Array): { source: RecordSource; restore: RestorableRecordSource["restoreField"] } {
  const wad = WadFile.parse(new Uint8Array(input));
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

  const source: RecordSource = {
    schema: SCHEMA,
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
      write(loc, field, (at) => wad.setField(at.lump, at.record, loc.index, field as never, value as never)),
    serialize: () => wad.serialize(),
  };
  const restore = (loc: RecordLocator, field: string, value: FieldValue): WriteOutcome =>
    write(loc, field, (at) => restoreWadField(wad, at.lump, at.record, loc.index, field, value));
  return { source, restore };
}

/** Sector.special 旧值非零时拦截写入 special（秘密房间、门类特效等）。 */
const sectorSpecialNonzero: ProtectionHook = Object.freeze({
  name: "sector-special-nonzero",
  severity: "block" as const,
  check: (change: Parameters<ProtectionHook["check"]>[0]) =>
    change.record === "Sector" && change.field === "special" && change.oldValue !== 0
      ? `Sector.special is ${String(change.oldValue)}, and non-zero specials are protected`
      : null,
});

export const wadAdapter: RecordAdapter = Object.freeze({
  format: "wad",
  hooks: Object.freeze([sectorSpecialNonzero]),
  open(input: Uint8Array): RecordSource {
    return build(input).source;
  },
});

function openRestorable(input: Uint8Array): RestorableRecordSource {
  const { source, restore } = build(input);
  return { ...source, restoreField: restore };
}

registerRestorer(wadAdapter, openRestorable);
