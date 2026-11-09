/**
 * 只读查询：用补丁的选择器（where、pin、all）选出记录，不计算新值、不写入、不跑保护钩子。
 * 校验和求值复用补丁引擎的同一套代码（validate.ts、select.ts），所以查询与补丁选中的记录一致。
 */
import { validatePinFingerprints, validateQuerySchema, validateQueryStructure, type Patch } from "./validate.ts";
import { evaluateSelectors } from "./select.ts";
import type { PatchIssue, PinResolution, RecordAdapter, RecordLocator, Selection } from "./source.ts";

export interface QueryResult {
  readonly ok: boolean;
  readonly issues: PatchIssue[];
  /** 选中的记录，按作用域（目录顺序）→ 下标。 */
  readonly records: Array<{ readonly locator: RecordLocator; readonly selection: Selection }>;
  /** pin 查询的解析结果（EXACT、RELOCATED 或冲突）；其他查询为空。 */
  readonly pins: PinResolution[];
}

/** 把补丁里的路径 /operations/0/... 改成相对查询的 /... 。 */
function rebase(issues: readonly PatchIssue[]): PatchIssue[] {
  return issues.map(({ operationId: _id, ...i }) => ({ ...i, ...(i.path !== undefined ? { path: i.path.replace(/^\/operations\/0(?=\/|$)/, "") } : {}) }));
}

export function queryRecords(input: Uint8Array, rawQuery: unknown, adapter: RecordAdapter): QueryResult {
  const fail = (issues: PatchIssue[]): QueryResult => ({ ok: false, issues, records: [], pins: [] });
  const v = validateQueryStructure(rawQuery);
  if (!v.ok) return fail(v.issues);
  const query = v.value;
  const source = adapter.open(input);
  const schemaIssues = validateQuerySchema(query, source.schema);
  if (schemaIssues.length > 0) return fail(schemaIssues);
  // 选择器求值只认识补丁，包成只有一个操作、不改任何字段的补丁；它不会经过 planPatch，change 不被读取
  const patch: Patch = { schemaVersion: 1, name: "query", target: { format: adapter.format, maps: query.maps }, operations: [{ id: "query", select: query.select, change: {} }] };
  const fpIssues = validatePinFingerprints(patch, source.fingerprints);
  if (fpIssues.length > 0) return fail(rebase(fpIssues));
  const r = evaluateSelectors(patch, source);
  const issues = rebase(r.issues);
  return { ok: issues.length === 0, issues, records: r.operations[0]!.records.map((x) => ({ locator: x.locator, selection: x.selection })), pins: r.pins };
}
