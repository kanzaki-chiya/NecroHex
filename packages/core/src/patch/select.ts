/**
 * 选择器求值。全部在写入前、按输入值进行，所以前一操作的写入不影响后一操作的匹配。
 * 结果顺序：操作 → 作用域（目录顺序）→ 下标。
 */
import { classifyPin, RELOCATION_THRESHOLDS } from "./relocate.ts";
import type { FieldValue, PatchIssue, PinResolution, RecordLocator, RecordReader, RecordScope, RelocationCandidate, Selection } from "./source.ts";
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
  /** 每个 pin 操作一条，按操作顺序。 */
  readonly pins: PinResolution[];
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

function resolvePin(
  op: Operation,
  n: number,
  inTarget: readonly RecordScope[],
  reader: RecordReader,
): { resolution: PinResolution; issue?: PatchIssue; record?: SelectedRecord } {
  if (!("pin" in op.select)) throw new TypeError("not a pin selector");
  const { record } = op.select;
  const { map, expectedIndex, fingerprint } = op.select.pin;
  const checked = fingerprint !== undefined;
  const path = pointer("operations", n, "select", "pin");
  const base = { operationId: op.id, map, record, expectedIndex, fingerprintChecked: false };
  const conflict = (
    code: "CONFLICT_MISSING" | "CONFLICT_AMBIGUOUS",
    message: string,
    at: string,
    extra: { scope?: string; candidates?: RelocationCandidate[]; candidateCount?: number; fingerprintChecked?: boolean } = {},
  ) => {
    const candidates = extra.candidates ?? [];
    return {
      resolution: {
        ...base,
        ...(extra.scope !== undefined ? { scope: extra.scope } : {}),
        fingerprintChecked: extra.fingerprintChecked ?? false,
        result: code,
        candidates,
        candidateCount: extra.candidateCount ?? 0,
        message,
      },
      issue: {
        code,
        message,
        operationId: op.id,
        path: at,
        ...(extra.candidates !== undefined ? { candidates: candidates.map((c) => ({ ...c })) } : {}),
      },
    };
  };

  const found = inTarget.filter((s) => sameName(s.name, map));
  if (found.length === 0) return conflict("CONFLICT_MISSING", `pin map ${map} does not exist`, path + "/map");
  if (found.length > 1) {
    return conflict("CONFLICT_AMBIGUOUS", `pin map ${map} matches ${found.length} maps (${found.map((s) => s.id).join(", ")}); refusing to guess`, path + "/map");
  }
  const scope = found[0]!;
  const count = reader.recordCount(scope.id, record);
  const label = `${scope.id} ${record}`;

  if (!checked) {
    // 没有指纹：只能按下标选中，不做重定位
    if (expectedIndex >= count) {
      return conflict("CONFLICT_MISSING", `${scope.id} has ${count} ${record} records; #${expectedIndex} does not exist`, path + "/expectedIndex", { scope: scope.id });
    }
    return {
      resolution: { ...base, scope: scope.id, result: "EXACT", index: expectedIndex, candidates: [], candidateCount: 0, message: `${label} #${expectedIndex} selected by index; no fingerprint was given, so nothing was verified` },
      record: { locator: { scope: scope.id, record, index: expectedIndex }, selection: { kind: "EXACT", expectedIndex, fingerprintChecked: false } },
    };
  }

  const fp = reader.fingerprints;
  if (!fp) throw new TypeError("pin has a fingerprint but the record source has no fingerprints; validatePinFingerprints should have rejected it");
  const scores = fp.scores(scope.id, record, fingerprint);
  if (scores.length !== count) throw new RangeError(`fingerprint scores for ${label}: got ${scores.length}, expected ${count}`);
  const c = classifyPin(scores, expectedIndex);
  const list = (cs: readonly RelocationCandidate[]) => cs.map((x) => `#${x.index} (${x.score})`).join(", ");
  const more = c.candidateCount > c.candidates.length ? ` and ${c.candidateCount - c.candidates.length} more` : "";
  const { high, low, margin } = RELOCATION_THRESHOLDS;
  if (c.result === "CONFLICT_MISSING") {
    return conflict("CONFLICT_MISSING", `no ${label} record scores at least ${low} against the fingerprint of #${expectedIndex}`, path + "/fingerprint", {
      scope: scope.id,
      candidates: [],
      candidateCount: 0,
      fingerprintChecked: true,
    });
  }
  if (c.result === "CONFLICT_AMBIGUOUS") {
    const why =
      c.candidates[0]!.score < high
        ? `no candidate reaches ${high}`
        : c.candidateCount > 1 && c.candidates[1]!.score >= high
          ? `more than one candidate reaches ${high}`
          : `the runner-up is within ${margin} of the best candidate`;
    return conflict("CONFLICT_AMBIGUOUS", `${label} #${expectedIndex}: ${why}; candidates ${list(c.candidates)}${more}; refusing to guess`, path + "/fingerprint", {
      scope: scope.id,
      candidates: c.candidates,
      candidateCount: c.candidateCount,
      fingerprintChecked: true,
    });
  }
  const message =
    c.result === "EXACT"
      ? `${label} #${expectedIndex} matches its fingerprint (${c.score})`
      : `${label} #${expectedIndex} → #${c.index}: the only candidate that matches the fingerprint (${c.score})`;
  return {
    resolution: { ...base, scope: scope.id, result: c.result, index: c.index, fingerprintChecked: true, score: c.score, candidates: c.candidates, candidateCount: c.candidateCount, message },
    record: {
      locator: { scope: scope.id, record, index: c.index },
      selection: { kind: c.result, expectedIndex, fingerprintChecked: true, score: c.score },
    },
  };
}

export function evaluateSelectors(patch: Patch, reader: RecordReader): SelectionResult {
  const issues: PatchIssue[] = [];
  const pins: PinResolution[] = [];
  const all = reader.scopes();
  const inTarget = targetScopes(patch, all, issues);
  const operations = patch.operations.map((op, n): OperationSelection => {
    const { select } = op;
    const records: SelectedRecord[] = [];
    if ("pin" in select) {
      const pin = resolvePin(op, n, inTarget, reader);
      pins.push(pin.resolution);
      if (pin.issue) issues.push(pin.issue);
      if (pin.record) records.push(pin.record);
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
  return { operations, issues, pins };
}
