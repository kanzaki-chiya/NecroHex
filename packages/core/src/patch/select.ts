/**
 * 选择器求值。全部在写入前、按输入值进行，所以前一操作的写入不影响后一操作的匹配。
 * 结果顺序：操作 → 作用域（目录顺序）→ 下标。
 */
import type { FieldValue, PatchIssue, RecordLocator, RecordReader, RecordScope, Selection } from "./source.ts";
import { pointer, type Condition, type Operation, type Patch } from "./validate.ts";

export interface SelectedRecord {
  readonly locator: RecordLocator;
  readonly selection: Selection;
}

export interface OperationSelection {
  readonly operation: Operation;
  readonly records: SelectedRecord[];
}

export interface SelectionResult {
  readonly operations: OperationSelection[];
  readonly issues: PatchIssue[];
}

/** 只把 ASCII a–z 转大写，其余码元不变。 */
export function asciiUpper(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 0x61 && c <= 0x7a ? String.fromCharCode(c - 0x20) : s[i];
  }
  return out;
}

function sameName(a: string, b: string): boolean {
  return asciiUpper(a) === asciiUpper(b);
}

/** 单个字段条件；各算子之间为"与"。name 字段只会带 eq、ne、in（由校验保证）。 */
export function matchesCondition(value: FieldValue, cond: Condition): boolean {
  const norm = (v: FieldValue): FieldValue => (typeof v === "string" ? asciiUpper(v) : v);
  const x = norm(value);
  if (cond.eq !== undefined && x !== norm(cond.eq)) return false;
  if (cond.ne !== undefined && x === norm(cond.ne)) return false;
  if (cond.in !== undefined && !cond.in.some((v) => norm(v) === x)) return false;
  if (typeof x === "number") {
    if (cond.lt !== undefined && !(x < (cond.lt as number))) return false;
    if (cond.lte !== undefined && !(x <= (cond.lte as number))) return false;
    if (cond.gt !== undefined && !(x > (cond.gt as number))) return false;
    if (cond.gte !== undefined && !(x >= (cond.gte as number))) return false;
  }
  return true;
}

/** target.maps 对应的作用域；列出的名称不存在时报 CONFLICT_MISSING。 */
function targetScopes(patch: Patch, scopes: readonly RecordScope[], issues: PatchIssue[]): RecordScope[] {
  if (patch.target.maps === "*") return [...scopes];
  const wanted = patch.target.maps;
  wanted.forEach((name, i) => {
    if (!scopes.some((s) => sameName(s.name, name))) {
      issues.push({ code: "CONFLICT_MISSING", message: `map ${name} listed in target.maps does not exist`, path: pointer("target", "maps", i) });
    }
  });
  return scopes.filter((s) => wanted.some((name) => sameName(s.name, name)));
}

export function evaluateSelectors(patch: Patch, reader: RecordReader): SelectionResult {
  const issues: PatchIssue[] = [];
  const all = reader.scopes();
  const inTarget = targetScopes(patch, all, issues);
  const operations = patch.operations.map((op, n): OperationSelection => {
    const { select } = op;
    const records: SelectedRecord[] = [];
    if ("pin" in select) {
      const { map, expectedIndex } = select.pin;
      const path = pointer("operations", n, "select", "pin");
      const found = inTarget.filter((s) => sameName(s.name, map));
      if (found.length === 0) {
        issues.push({ code: "CONFLICT_MISSING", message: `pin map ${map} does not exist`, operationId: op.id, path: path + "/map" });
      } else if (found.length > 1) {
        issues.push({
          code: "CONFLICT_AMBIGUOUS",
          message: `pin map ${map} matches ${found.length} maps (${found.map((s) => s.id).join(", ")}); refusing to guess`,
          operationId: op.id,
          path: path + "/map",
        });
      } else {
        const scope = found[0]!;
        const count = reader.recordCount(scope.id, select.record);
        if (expectedIndex >= count) {
          issues.push({
            code: "CONFLICT_MISSING",
            message: `${scope.id} has ${count} ${select.record} records; #${expectedIndex} does not exist`,
            operationId: op.id,
            path: path + "/expectedIndex",
          });
        } else {
          records.push({
            locator: { scope: scope.id, record: select.record, index: expectedIndex },
            selection: { kind: "EXACT", expectedIndex, fingerprintChecked: false },
          });
        }
      }
      return { operation: op, records };
    }
    const where = "where" in select ? Object.entries(select.where) : null;
    const selection: Selection = where ? { kind: "WHERE" } : { kind: "ALL" };
    for (const scope of inTarget) {
      const count = reader.recordCount(scope.id, select.record);
      for (let index = 0; index < count; index++) {
        const locator = { scope: scope.id, record: select.record, index };
        if (where && !where.every(([field, cond]) => matchesCondition(reader.readField(locator, field), cond))) continue;
        records.push({ locator, selection });
      }
    }
    return { operation: op, records };
  });
  return { operations, issues };
}
