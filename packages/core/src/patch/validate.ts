/**
 * 补丁校验，分三段：
 * 1. validatePatchStructure：只看补丁本身（白名单、必需键、选择器形状、算子形状），不需要 adapter；patchHash 也用它。
 * 2. checkPatchAgainstAdapter：target.format 与 allowProtected，只用 adapter 的静态属性，仍不打开 Record_Source。
 * 3. validatePatchSchema：打开 Record_Source 之后按 schema 校验记录、字段和值类型。
 * 每一段收集本段全部问题；任一段有问题，流水线立即返回。
 */
import { canonicalJson } from "../hash.ts";
import type { FieldKind, FieldValue, PatchIssue, RecordAdapter, RecordFingerprints, RecordSchema } from "./source.ts";

export type ConditionOp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
export type Condition = Partial<Record<ConditionOp, FieldValue>> & { in?: FieldValue[] };

export type Selector =
  | { record: string; where: Record<string, Condition> }
  | { record: string; pin: { map: string; expectedIndex: number; fingerprint?: unknown } }
  | { record: string; all: true };

export type Change = { set: FieldValue } | { scale: number; clamp?: [number, number] } | { clamp: [number, number] };

export interface Operation {
  id: string;
  select: Selector;
  change: Record<string, Change>;
}

export interface Patch {
  schemaVersion: 1;
  name: string;
  target: { format: string; maps: "*" | string[] };
  allowProtected?: string[];
  operations: Operation[];
}

export type Validated<T> = { ok: true; value: T } | { ok: false; issues: PatchIssue[] };

const COMPARE_OPS: readonly ConditionOp[] = ["eq", "ne", "lt", "lte", "gt", "gte"];
const ORDER_OPS: readonly ConditionOp[] = ["lt", "lte", "gt", "gte"];

/** JSON Pointer 片段转义（RFC 6901）。 */
export function pointer(...parts: Array<string | number>): string {
  return parts.map((p) => "/" + String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isFieldValue(v: unknown): v is FieldValue {
  return typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
}

function has(o: Record<string, unknown>, k: string): boolean {
  return Object.hasOwn(o, k);
}

class Collector {
  readonly issues: PatchIssue[] = [];
  add(message: string, path: string, operationId?: string): void {
    this.issues.push({ code: "INVALID_PATCH", message, path, ...(operationId !== undefined ? { operationId } : {}) });
  }
  /** 对象中不在白名单里的键（包括 offset、bytes 等裸写入描述）。 */
  unknownKeys(o: Record<string, unknown>, allowed: readonly string[], base: string, operationId?: string): void {
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k)) this.add(`unknown key ${JSON.stringify(k)}`, base + pointer(k), operationId);
    }
  }
}

/** 第 1 段：结构校验。成功时返回只含白名单键的新对象，与输入不共享引用。 */
export function validatePatchStructure(input: unknown): Validated<Patch> {
  const c = new Collector();
  if (!isPlainObject(input)) {
    c.add("patch must be a JSON object", "");
    return { ok: false, issues: c.issues };
  }
  c.unknownKeys(input, ["schemaVersion", "name", "target", "allowProtected", "operations"], "");

  if (!has(input, "schemaVersion")) c.add("schemaVersion is required", "/schemaVersion");
  else if (input.schemaVersion !== 1) c.add("schemaVersion must be 1", "/schemaVersion");

  if (!has(input, "name")) c.add("name is required", "/name");
  else if (typeof input.name !== "string") c.add("name must be a string", "/name");

  let mapNames: Set<string> | "*" | undefined;
  if (!has(input, "target")) c.add("target is required", "/target");
  else if (!isPlainObject(input.target)) c.add("target must be an object", "/target");
  else {
    const t = input.target;
    c.unknownKeys(t, ["format", "maps"], "/target");
    if (!has(t, "format")) c.add("target.format is required", "/target/format");
    else if (typeof t.format !== "string" || t.format === "") c.add("target.format must be a non-empty string", "/target/format");
    if (!has(t, "maps")) c.add("target.maps is required", "/target/maps");
    else if (t.maps === "*") mapNames = "*";
    else if (!Array.isArray(t.maps) || t.maps.length === 0) c.add('target.maps must be "*" or a non-empty array of map names', "/target/maps");
    else {
      const seen = new Set<string>();
      t.maps.forEach((m, i) => {
        if (typeof m !== "string" || m === "") c.add("map name must be a non-empty string", pointer("target", "maps", i));
        else if (seen.has(m.toUpperCase())) c.add(`map ${m} is listed twice`, pointer("target", "maps", i));
        else seen.add(m.toUpperCase());
      });
      mapNames = seen;
    }
  }

  if (has(input, "allowProtected")) {
    const a = input.allowProtected;
    if (!Array.isArray(a)) c.add("allowProtected must be an array of hook names", "/allowProtected");
    else a.forEach((h, i) => {
      if (typeof h !== "string" || h === "") c.add("hook name must be a non-empty string", pointer("allowProtected", i));
    });
  }

  const ids = new Set<string>();
  if (!has(input, "operations")) c.add("operations is required", "/operations");
  else if (!Array.isArray(input.operations) || input.operations.length === 0) c.add("operations must be a non-empty array", "/operations");
  else input.operations.forEach((op, n) => checkOperation(c, op, n, ids, mapNames));

  if (c.issues.length > 0) return { ok: false, issues: c.issues };
  return { ok: true, value: copyPatch(input) };
}

function checkOperation(c: Collector, op: unknown, n: number, ids: Set<string>, mapNames: Set<string> | "*" | undefined): void {
  const base = pointer("operations", n);
  if (!isPlainObject(op)) {
    c.add("operation must be an object", base);
    return;
  }
  const id = typeof op.id === "string" && op.id !== "" ? op.id : undefined;
  c.unknownKeys(op, ["id", "select", "change"], base, id);
  if (!has(op, "id")) c.add("operation id is required", base + "/id");
  else if (id === undefined) c.add("operation id must be a non-empty string", base + "/id");
  else if (ids.has(id)) c.add(`operation id ${JSON.stringify(id)} is used more than once`, base + "/id", id);
  else ids.add(id);

  if (!has(op, "select")) c.add("select is required", base + "/select", id);
  else checkSelect(c, op.select, base + "/select", id, mapNames);

  if (!has(op, "change")) c.add("change is required", base + "/change", id);
  else if (!isPlainObject(op.change) || Object.keys(op.change).length === 0) c.add("change must be a non-empty object", base + "/change", id);
  else for (const [field, ch] of Object.entries(op.change)) checkChange(c, ch, base + pointer("change", field), id);
}

function checkSelect(c: Collector, s: unknown, base: string, id: string | undefined, mapNames: Set<string> | "*" | undefined): void {
  if (!isPlainObject(s)) {
    c.add("select must be an object", base, id);
    return;
  }
  c.unknownKeys(s, ["record", "where", "pin", "all"], base, id);
  if (!has(s, "record")) c.add("select.record is required", base + "/record", id);
  else if (typeof s.record !== "string" || s.record === "") c.add("select.record must be a non-empty string", base + "/record", id);

  const kinds = (["where", "pin", "all"] as const).filter((k) => has(s, k));
  if (kinds.length !== 1) {
    c.add("select must contain exactly one of where, pin or all", base, id);
    return;
  }
  const kind = kinds[0]!;
  if (kind === "all") {
    if (s.all !== true) c.add("select.all must be the literal true", base + "/all", id);
    return;
  }
  if (kind === "where") {
    const w = s.where;
    if (!isPlainObject(w)) c.add("select.where must be an object", base + "/where", id);
    else if (Object.keys(w).length === 0) c.add("select.where has no conditions; use \"all\": true to select every record", base + "/where", id);
    else for (const [field, cond] of Object.entries(w)) checkCondition(c, cond, base + pointer("where", field), id);
    return;
  }
  const p = s.pin;
  const pb = base + "/pin";
  if (!isPlainObject(p)) {
    c.add("select.pin must be an object", pb, id);
    return;
  }
  c.unknownKeys(p, ["map", "expectedIndex", "fingerprint"], pb, id);
  if (!has(p, "map")) c.add("pin.map is required", pb + "/map", id);
  else if (typeof p.map !== "string" || p.map === "") c.add("pin.map must be a non-empty string", pb + "/map", id);
  else if (mapNames instanceof Set && !mapNames.has(p.map.toUpperCase())) c.add(`pin.map ${p.map} is not listed in target.maps`, pb + "/map", id);
  if (!has(p, "expectedIndex")) c.add("pin.expectedIndex is required", pb + "/expectedIndex", id);
  else if (typeof p.expectedIndex !== "number" || !Number.isSafeInteger(p.expectedIndex) || p.expectedIndex < 0) {
    c.add("pin.expectedIndex must be a non-negative integer", pb + "/expectedIndex", id);
  }
  if (has(p, "fingerprint")) {
    try {
      canonicalJson(p.fingerprint);
    } catch {
      c.add("pin.fingerprint must be a JSON value", pb + "/fingerprint", id);
    }
  }
}

function checkCondition(c: Collector, cond: unknown, base: string, id: string | undefined): void {
  if (!isPlainObject(cond)) {
    c.add("condition must be an object", base, id);
    return;
  }
  if (Object.keys(cond).length === 0) {
    c.add("condition is empty", base, id);
    return;
  }
  c.unknownKeys(cond, [...COMPARE_OPS, "in"], base, id);
  for (const op of COMPARE_OPS) {
    if (has(cond, op) && !isFieldValue(cond[op])) c.add(`${op} must be a finite number or a string`, base + pointer(op), id);
  }
  if (has(cond, "in")) {
    const list = cond.in;
    if (!Array.isArray(list) || list.length === 0) c.add("in must be a non-empty array", base + "/in", id);
    else list.forEach((v, i) => {
      if (!isFieldValue(v)) c.add("in values must be finite numbers or strings", base + pointer("in", i), id);
    });
  }
}

function checkClamp(c: Collector, v: unknown, path: string, id: string | undefined): void {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    c.add("clamp must be [min, max] with two finite numbers", path, id);
  } else if (v[0] > v[1]) {
    c.add(`clamp min ${v[0]} is greater than max ${v[1]}`, path, id);
  }
}

function checkChange(c: Collector, ch: unknown, base: string, id: string | undefined): void {
  if (!isPlainObject(ch)) {
    c.add("change must be an object", base, id);
    return;
  }
  c.unknownKeys(ch, ["set", "scale", "clamp"], base, id);
  const hasSet = has(ch, "set");
  const hasScale = has(ch, "scale");
  const hasClamp = has(ch, "clamp");
  if (hasSet) {
    if (hasScale || hasClamp) c.add("set cannot be combined with scale or clamp", base, id);
    if (!isFieldValue(ch.set)) c.add("set must be a finite number or a string", base + "/set", id);
    return;
  }
  if (!hasScale && !hasClamp) {
    c.add("change must contain set, scale or clamp", base, id);
    return;
  }
  if (hasScale && (typeof ch.scale !== "number" || !Number.isFinite(ch.scale))) c.add("scale must be a finite number", base + "/scale", id);
  if (hasClamp) checkClamp(c, ch.clamp, base + "/clamp", id);
}

function copyCondition(cond: Record<string, unknown>): Condition {
  const out: Condition = {};
  for (const op of COMPARE_OPS) if (has(cond, op)) out[op] = cond[op] as FieldValue;
  if (has(cond, "in")) out.in = [...(cond.in as FieldValue[])];
  return out;
}

function copyChange(ch: Record<string, unknown>): Change {
  if (has(ch, "set")) return { set: ch.set as FieldValue };
  const clamp = has(ch, "clamp") ? ([...(ch.clamp as number[])] as [number, number]) : undefined;
  if (has(ch, "scale")) return clamp ? { scale: ch.scale as number, clamp } : { scale: ch.scale as number };
  return { clamp: clamp! };
}

/** 结构校验通过之后调用：按白名单复制选择器，fingerprint 经规范 JSON 深复制。 */
function copySelect(s: Record<string, unknown>): Selector {
  const record = s.record as string;
  if (has(s, "all")) return { record, all: true };
  if (has(s, "where")) {
    const where: Record<string, Condition> = {};
    for (const [f, cond] of Object.entries(s.where as Record<string, unknown>)) where[f] = copyCondition(cond as Record<string, unknown>);
    return { record, where };
  }
  const pin = s.pin as Record<string, unknown>;
  return {
    record,
    pin: {
      map: pin.map as string,
      expectedIndex: pin.expectedIndex as number,
      ...(has(pin, "fingerprint") && pin.fingerprint !== undefined ? { fingerprint: JSON.parse(canonicalJson(pin.fingerprint)) as unknown } : {}),
    },
  };
}

/** 结构校验通过之后调用：按白名单复制。 */
function copyPatch(p: Record<string, unknown>): Patch {
  const t = p.target as Record<string, unknown>;
  const ops = (p.operations as Record<string, unknown>[]).map((op): Operation => {
    const select = copySelect(op.select as Record<string, unknown>);
    const change: Record<string, Change> = {};
    for (const [f, ch] of Object.entries(op.change as Record<string, unknown>)) change[f] = copyChange(ch as Record<string, unknown>);
    return { id: op.id as string, select, change };
  });
  return {
    schemaVersion: 1,
    name: p.name as string,
    target: { format: t.format as string, maps: t.maps === "*" ? "*" : [...(t.maps as string[])] },
    ...(has(p, "allowProtected") ? { allowProtected: [...(p.allowProtected as string[])] } : {}),
    operations: ops,
  };
}

/** 第 2 段：只用 adapter 的静态属性，不打开 Record_Source。 */
export function checkPatchAgainstAdapter(patch: Patch, adapter: RecordAdapter): PatchIssue[] {
  const c = new Collector();
  if (patch.target.format !== adapter.format) {
    c.add(`target.format ${JSON.stringify(patch.target.format)} does not match adapter format ${JSON.stringify(adapter.format)}`, "/target/format");
  }
  const hooks = new Set(adapter.hooks.map((h) => h.name));
  patch.allowProtected?.forEach((h, i) => {
    if (!hooks.has(h)) c.add(`allowProtected names unknown hook ${JSON.stringify(h)}`, pointer("allowProtected", i));
  });
  return c.issues;
}

function valueMatchesKind(v: FieldValue, kind: FieldKind): boolean {
  return kind === "int" ? typeof v === "number" : kind === "name" ? typeof v === "string" : false;
}

/**
 * 第 3 段的一部分：pin.fingerprint 交给 adapter 校验形状。
 * adapter 不提供指纹，或该记录类型不支持指纹时，带 fingerprint 的 pin 为 INVALID_PATCH，不忽略。
 */
export function validatePinFingerprints(patch: Patch, fingerprints: RecordFingerprints | undefined): PatchIssue[] {
  const c = new Collector();
  patch.operations.forEach((op, n) => {
    if (!("pin" in op.select) || op.select.pin.fingerprint === undefined) return;
    const base = pointer("operations", n, "select", "pin", "fingerprint");
    const { record } = op.select;
    if (!fingerprints || !fingerprints.records.includes(record)) {
      const supported = fingerprints && fingerprints.records.length > 0 ? `; supported: ${fingerprints.records.join(", ")}` : "";
      c.add(`${record} records do not support fingerprints${supported}`, base, op.id);
      return;
    }
    for (const p of fingerprints.validate(record, op.select.pin.fingerprint)) c.add(`fingerprint: ${p.message}`, base + p.path, op.id);
  });
  return c.issues;
}

/** 第 3 段：打开 Record_Source 之后按 schema 校验。 */
export function validatePatchSchema(patch: Patch, schema: RecordSchema): PatchIssue[] {
  const c = new Collector();
  patch.operations.forEach((op, n) => {
    const base = pointer("operations", n);
    const id = op.id;
    const rec = Object.hasOwn(schema, op.select.record) ? schema[op.select.record] : undefined;
    if (!rec) {
      c.add(`record type ${op.select.record} is not declared`, base + "/select/record", id);
      return;
    }
    if (!rec.writable) c.add(`${op.select.record} records are read-only`, base + "/select/record", id);
    const kindOf = (f: string): FieldKind | undefined => (Object.hasOwn(rec.fields, f) ? rec.fields[f] : undefined);

    checkWhereSchema(c, op.select, rec.fields, base, id);

    for (const [field, ch] of Object.entries(op.change)) {
      const p = base + "/change" + pointer(field);
      const kind = kindOf(field);
      if (kind === undefined) {
        c.add(`${op.select.record} has no field ${field}`, p, id);
        continue;
      }
      if (kind === "other") {
        c.add(`${op.select.record}.${field} cannot be changed`, p, id);
        continue;
      }
      if ("set" in ch) {
        if (!valueMatchesKind(ch.set, kind)) c.add(`set value type does not match ${op.select.record}.${field} (${kind})`, p + "/set", id);
      } else if (kind !== "int") {
        c.add(`${"scale" in ch ? "scale" : "clamp"} is only allowed on integer fields; ${op.select.record}.${field} is a name`, p + ("scale" in ch ? "/scale" : "/clamp"), id);
      }
    }
  });
  return c.issues;
}

/** where 条件按 schema 校验：字段存在、可用于条件、值类型与字段一致、名称字段不用大小比较。 */
function checkWhereSchema(c: Collector, select: Selector, fields: Readonly<Record<string, FieldKind>>, base: string, id: string | undefined): void {
  if (!("where" in select)) return;
  for (const [field, cond] of Object.entries(select.where)) {
    const p = base + "/select/where" + pointer(field);
    const kind = Object.hasOwn(fields, field) ? fields[field] : undefined;
    if (kind === undefined) {
      c.add(`${select.record} has no field ${field}`, p, id);
      continue;
    }
    if (kind === "other") {
      c.add(`${select.record}.${field} cannot be used in a condition`, p, id);
      continue;
    }
    for (const o of COMPARE_OPS) {
      const v = cond[o];
      if (v === undefined) continue;
      if (kind === "name" && ORDER_OPS.includes(o)) c.add(`${o} is only allowed on integer fields; ${select.record}.${field} is a name`, p + pointer(o), id);
      else if (!valueMatchesKind(v, kind)) c.add(`${o} value type does not match ${select.record}.${field} (${kind})`, p + pointer(o), id);
    }
    cond.in?.forEach((v, i) => {
      if (!valueMatchesKind(v, kind)) c.add(`in value type does not match ${select.record}.${field} (${kind})`, p + pointer("in", i), id);
    });
  }
}

/** 只读查询：在哪些地图上（默认全部）用哪个选择器。选择器的规则与补丁完全相同。 */
export interface Query {
  maps: "*" | string[];
  select: Selector;
}

/** 查询的结构校验，路径相对查询对象（例如 /select/where/type）。 */
export function validateQueryStructure(input: unknown): Validated<Query> {
  const c = new Collector();
  if (!isPlainObject(input)) {
    c.add("query must be a JSON object", "");
    return { ok: false, issues: c.issues };
  }
  c.unknownKeys(input, ["maps", "select"], "");
  let mapNames: Set<string> | "*" = "*";
  if (has(input, "maps") && input.maps !== "*") {
    if (!Array.isArray(input.maps) || input.maps.length === 0) c.add('maps must be "*" or a non-empty array of map names', "/maps");
    else {
      const seen = new Set<string>();
      input.maps.forEach((m, i) => {
        if (typeof m !== "string" || m === "") c.add("map name must be a non-empty string", pointer("maps", i));
        else if (seen.has(m.toUpperCase())) c.add(`map ${m} is listed twice`, pointer("maps", i));
        else seen.add(m.toUpperCase());
      });
      mapNames = seen;
    }
  }
  if (!has(input, "select")) c.add("select is required", "/select");
  else checkSelect(c, input.select, "/select", undefined, mapNames);
  if (c.issues.length > 0) return { ok: false, issues: c.issues };
  const maps = has(input, "maps") && input.maps !== "*" ? [...(input.maps as string[])] : "*";
  return { ok: true, value: { maps, select: copySelect(input.select as Record<string, unknown>) } };
}

/** 查询按 schema 校验。查询只读，所以只读记录（例如 Linedef）也可以查询。 */
export function validateQuerySchema(query: Query, schema: RecordSchema): PatchIssue[] {
  const c = new Collector();
  const rec = Object.hasOwn(schema, query.select.record) ? schema[query.select.record] : undefined;
  if (!rec) c.add(`record type ${query.select.record} is not declared`, "/select/record");
  else checkWhereSchema(c, query.select, rec.fields, "", undefined);
  return c.issues;
}
