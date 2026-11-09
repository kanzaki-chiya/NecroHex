/**
 * 内存假 Record_Source，供 core 的纯逻辑测试使用。
 * 字节格式是只含 ASCII 的 JSON：{ scopes, data }，所以哈希随内容变化，测试可以直接改字节。
 * 字段区间是合成的：按 作用域 → 记录 → 下标 → 字段 的顺序，每个字段占 8 字节。
 */
import type {
  FieldValue,
  ProtectionHook,
  RecordAdapter,
  RecordLocator,
  RecordSchema,
  RecordScope,
  WriteOutcome,
} from "../src/index.ts";
import { registerRestorer, type RestorableRecordSource } from "../src/internal.ts";

export type FakeRows = Record<string, FieldValue>[];

export interface FakeModel {
  scopes: RecordScope[];
  /** scope id → record → rows。缺记录类型表示缺该 Lump。 */
  data: Record<string, Record<string, FakeRows>>;
}

export interface FakeConfig {
  schema?: RecordSchema;
  hooks?: ProtectionHook[];
  /** 返回非 null 表示 writeField 拒绝该值，返回值为 reason。默认：int 字段只接受 -32768..32767 的整数，name 只接受 1 到 8 个字符。 */
  rejectValue?: (loc: RecordLocator, field: string, value: FieldValue) => string | null;
  /** canRestore 返回 false 的字段，键为 key(loc, field)。 */
  notRestorable?: Iterable<string>;
  /** restoreField 失败的字段，键为 key(loc, field)。 */
  restoreFails?: Iterable<string>;
  /** 不登记写回通道。 */
  unregistered?: boolean;
  format?: string;
}

export const DEFAULT_SCHEMA: RecordSchema = {
  Sector: { writable: true, fields: { lightlevel: "int", special: "int", tag: "int", floorpic: "name", raw: "other" } },
  Thing: { writable: true, fields: { type: "int", x: "int" } },
  Vertex: { writable: false, fields: { x: "int" } },
};

export function key(loc: RecordLocator, field: string): string {
  return `${loc.scope}/${loc.record}/${loc.index}/${field}`;
}

export function encodeModel(model: FakeModel): Uint8Array {
  const json = JSON.stringify(model).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const out = new Uint8Array(json.length);
  for (let i = 0; i < json.length; i++) out[i] = json.charCodeAt(i);
  return out;
}

export function decodeModel(bytes: Uint8Array): FakeModel {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return JSON.parse(s) as FakeModel;
}

export interface FakeCounts {
  open: number;
  restorableOpen: number;
  restoreField: number;
  writeField: number;
}

export interface Fake {
  adapter: RecordAdapter;
  counts: FakeCounts;
}

function defaultReject(schema: RecordSchema) {
  return (loc: RecordLocator, field: string, value: FieldValue): string | null => {
    const kind = schema[loc.record]?.fields[field];
    if (kind === "int") return typeof value === "number" && Number.isInteger(value) && value >= -32768 && value <= 32767 ? null : "RANGE";
    if (kind === "name") return typeof value === "string" && value.length >= 1 && value.length <= 8 ? null : "RANGE";
    return "TYPE";
  };
}

export function makeFake(config: FakeConfig = {}): Fake {
  const schema = config.schema ?? DEFAULT_SCHEMA;
  const reject = config.rejectValue ?? defaultReject(schema);
  const notRestorable = new Set(config.notRestorable ?? []);
  const restoreFails = new Set(config.restoreFails ?? []);
  const counts: FakeCounts = { open: 0, restorableOpen: 0, restoreField: 0, writeField: 0 };

  function openSource(input: Uint8Array): RestorableRecordSource {
    const model = decodeModel(new Uint8Array(input));
    const rows = (loc: RecordLocator): FakeRows => {
      const r = model.data[loc.scope]?.[loc.record];
      if (!r || loc.index < 0 || loc.index >= r.length) throw new RangeError(`no ${key(loc, "")}`);
      return r;
    };
    const fieldSpan = (loc: RecordLocator, field: string) => {
      rows(loc);
      const rec = schema[loc.record];
      if (!rec || !Object.hasOwn(rec.fields, field)) throw new RangeError(`${loc.record} has no field ${field}`);
      const fields = Object.keys(rec.fields);
      let k = 0;
      for (const s of model.scopes) {
        for (const r of Object.keys(schema)) {
          const n = model.data[s.id]?.[r]?.length ?? 0;
          if (s.id === loc.scope && r === loc.record) {
            k += loc.index * Object.keys(schema[r]!.fields).length + fields.indexOf(field);
            return { start: k * 8, end: k * 8 + 8 };
          }
          k += n * Object.keys(schema[r]!.fields).length;
        }
      }
      throw new RangeError("unreachable");
    };
    const put = (loc: RecordLocator, field: string, value: FieldValue): WriteOutcome => {
      if (!schema[loc.record]?.writable) return { ok: false, reason: "READ_ONLY", message: `${loc.record} is read-only` };
      const span = fieldSpan(loc, field);
      const row = rows(loc)[loc.index]!;
      const unchanged = row[field] === value;
      row[field] = value;
      return { ok: true, span, unchanged };
    };
    return {
      schema,
      scopes: () => model.scopes.map((s) => ({ ...s })),
      recordCount: (scope, record) => model.data[scope]?.[record]?.length ?? 0,
      readField: (loc, field) => {
        const v = rows(loc)[loc.index]![field];
        if (v === undefined) throw new RangeError(`no field ${field}`);
        return v;
      },
      fieldSpan,
      canRestore: (loc, field) => !notRestorable.has(key(loc, field)),
      writeField: (loc, field, value) => {
        counts.writeField++;
        const why = reject(loc, field, value);
        if (why !== null) return { ok: false, reason: why, message: `value ${JSON.stringify(value)} rejected` };
        return put(loc, field, value);
      },
      restoreField: (loc, field, value) => {
        counts.restoreField++;
        if (restoreFails.has(key(loc, field))) return { ok: false, reason: "RESTORE_REJECTED", message: "restore refused by the fake" };
        return put(loc, field, value);
      },
      serialize: () => encodeModel(model),
    };
  }

  const adapter: RecordAdapter = {
    format: config.format ?? "fake",
    hooks: config.hooks ?? [],
    open(input) {
      counts.open++;
      return openSource(input);
    },
  };
  if (!config.unregistered) {
    registerRestorer(adapter, (input) => {
      counts.restorableOpen++;
      return openSource(input);
    });
  }
  return { adapter, counts };
}

/** 两个作用域 MAP01、MAP02，各 3 个扇区和 2 个 Thing，MAP02 没有 Vertex。 */
export function sampleModel(): FakeModel {
  const sectors = (base: number): FakeRows =>
    [0, 1, 2].map((i) => ({ lightlevel: base + i * 40, special: i === 2 ? 9 : 0, tag: i, floorpic: i === 1 ? "nukage1" : "FLAT1", raw: 0 }));
  return {
    scopes: [
      { id: "MAP01", name: "MAP01" },
      { id: "MAP02", name: "MAP02" },
    ],
    data: {
      MAP01: { Sector: sectors(100), Thing: [{ type: 1, x: 0 }, { type: 3001, x: 5 }], Vertex: [{ x: 1 }] },
      MAP02: { Sector: sectors(140), Thing: [{ type: 1, x: 0 }, { type: 9, x: 7 }] },
    },
  };
}
