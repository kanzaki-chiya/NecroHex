/**
 * Receipt 的生成与白名单校验。Receipt 只含 JSON 原生类型，JSON 往返后仍可用于撤销和重复应用检测。
 */
import type { FieldValue, PatchIssue, PlannedChange, Selection } from "./source.ts";
import { pointer } from "./validate.ts";

export interface Receipt {
  readonly receiptVersion: 1;
  readonly patchName: string;
  readonly patchHash: string;
  readonly inputHash: string;
  readonly outputHash: string;
  /** 本次实际放行的钩子，按名称排序。 */
  readonly allowedProtections: string[];
  /** 每个被写字段一条，含 unchanged: true 的条目。 */
  readonly entries: PlannedChange[];
}

const HASH = /^sha256:[0-9a-f]{64}$/;

/** 复制一条改动，得到只含 JSON 原生类型、与引擎内部不共享引用的对象。 */
export function copyChange(c: PlannedChange): PlannedChange {
  const selection: Selection =
    c.selection.kind === "EXACT" ? { kind: "EXACT", expectedIndex: c.selection.expectedIndex, fingerprintChecked: false } : { kind: c.selection.kind };
  return {
    operationId: c.operationId,
    scope: c.scope,
    record: c.record,
    index: c.index,
    field: c.field,
    oldValue: c.oldValue,
    newValue: c.newValue,
    span: { start: c.span.start, end: c.span.end },
    selection,
    unchanged: c.unchanged,
  };
}

export function makeReceipt(fields: Omit<Receipt, "receiptVersion" | "entries" | "allowedProtections"> & {
  allowedProtections: Iterable<string>;
  entries: readonly PlannedChange[];
}): Receipt {
  return {
    receiptVersion: 1,
    patchName: fields.patchName,
    patchHash: fields.patchHash,
    inputHash: fields.inputHash,
    outputHash: fields.outputHash,
    allowedProtections: [...new Set(fields.allowedProtections)].sort(),
    entries: fields.entries.map(copyChange),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const isIndex = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isFieldValue = (v: unknown): v is FieldValue => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
const isString = (v: unknown): v is string => typeof v === "string";

/**
 * 白名单校验。键必须恰好是规定的那些（不多不少），类型逐项检查。
 * 成功时返回复制后的 Receipt；失败时返回 INVALID_RECEIPT 问题，path 为 Receipt 内的 JSON Pointer，前缀为 base。
 */
export function validateReceipt(input: unknown, base = ""): { ok: true; value: Receipt } | { ok: false; issues: PatchIssue[] } {
  const issues: PatchIssue[] = [];
  const bad = (message: string, path: string) => issues.push({ code: "INVALID_RECEIPT", message, path: base + path });
  const exactKeys = (o: Record<string, unknown>, keys: readonly string[], path: string): void => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`unknown key ${JSON.stringify(k)}`, path + pointer(k));
    for (const k of keys) if (!Object.hasOwn(o, k)) bad(`${k} is required`, path + pointer(k));
  };

  if (!isPlainObject(input)) {
    bad("receipt must be a JSON object", "");
    return { ok: false, issues };
  }
  exactKeys(input, ["receiptVersion", "patchName", "patchHash", "inputHash", "outputHash", "allowedProtections", "entries"], "");
  if (Object.hasOwn(input, "receiptVersion") && input.receiptVersion !== 1) bad("receiptVersion must be 1", "/receiptVersion");
  if (Object.hasOwn(input, "patchName") && !isString(input.patchName)) bad("patchName must be a string", "/patchName");
  for (const k of ["patchHash", "inputHash", "outputHash"]) {
    if (Object.hasOwn(input, k) && !(isString(input[k]) && HASH.test(input[k]))) bad(`${k} must match sha256:<64 lowercase hex digits>`, pointer(k));
  }
  if (Object.hasOwn(input, "allowedProtections")) {
    const a = input.allowedProtections;
    if (!Array.isArray(a) || !a.every(isString)) bad("allowedProtections must be an array of strings", "/allowedProtections");
  }
  if (Object.hasOwn(input, "entries")) {
    const entries = input.entries;
    if (!Array.isArray(entries)) bad("entries must be an array", "/entries");
    else entries.forEach((e, i) => checkEntry(e, pointer("entries", i), bad, exactKeys));
  }
  if (issues.length > 0) return { ok: false, issues };
  const r = input as unknown as Receipt;
  return {
    ok: true,
    value: {
      receiptVersion: 1,
      patchName: r.patchName,
      patchHash: r.patchHash,
      inputHash: r.inputHash,
      outputHash: r.outputHash,
      allowedProtections: [...r.allowedProtections],
      entries: r.entries.map(copyChange),
    },
  };
}

function checkEntry(
  e: unknown,
  path: string,
  bad: (message: string, path: string) => void,
  exactKeys: (o: Record<string, unknown>, keys: readonly string[], path: string) => void,
): void {
  if (!isPlainObject(e)) {
    bad("entry must be an object", path);
    return;
  }
  exactKeys(e, ["operationId", "scope", "record", "index", "field", "oldValue", "newValue", "span", "selection", "unchanged"], path);
  for (const k of ["operationId", "scope", "record", "field"]) {
    if (Object.hasOwn(e, k) && !isString(e[k])) bad(`${k} must be a string`, path + pointer(k));
  }
  if (Object.hasOwn(e, "index") && !isIndex(e.index)) bad("index must be a non-negative integer", path + "/index");
  for (const k of ["oldValue", "newValue"]) {
    if (Object.hasOwn(e, k) && !isFieldValue(e[k])) bad(`${k} must be a finite number or a string`, path + pointer(k));
  }
  if (Object.hasOwn(e, "unchanged") && typeof e.unchanged !== "boolean") bad("unchanged must be a boolean", path + "/unchanged");
  if (Object.hasOwn(e, "span")) {
    const s = e.span;
    if (!isPlainObject(s)) bad("span must be an object", path + "/span");
    else {
      exactKeys(s, ["start", "end"], path + "/span");
      if (!isIndex(s.start) || !isIndex(s.end) || s.start > s.end) bad("span must be {start, end} with 0 <= start <= end", path + "/span");
    }
  }
  if (Object.hasOwn(e, "selection")) {
    const s = e.selection;
    const sp = path + "/selection";
    if (!isPlainObject(s)) bad("selection must be an object", sp);
    else if (s.kind === "WHERE" || s.kind === "ALL") exactKeys(s, ["kind"], sp);
    else if (s.kind === "EXACT") {
      exactKeys(s, ["kind", "expectedIndex", "fingerprintChecked"], sp);
      if (Object.hasOwn(s, "expectedIndex") && !isIndex(s.expectedIndex)) bad("expectedIndex must be a non-negative integer", sp + "/expectedIndex");
      if (Object.hasOwn(s, "fingerprintChecked") && s.fingerprintChecked !== false) bad("fingerprintChecked must be false", sp + "/fingerprintChecked");
    } else bad("selection.kind must be WHERE, ALL or EXACT", sp + "/kind");
  }
}
