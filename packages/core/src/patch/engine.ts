/**
 * 补丁引擎：planPatch（干跑）、applyPatch、revertPatch、patchHash、bytesHash。
 * 先在输入值上算好全部改动；有任一问题就不返回字节。干跑与应用共用同一条流水线。
 * 写回通道（restoreField）只在 revertPatch 中、核对全部通过之后调用。
 * 结果里的 checks 只列出做过哪些检查及结果，不声称地图可以通关。
 */
import { bytesHash as hashBytes, canonicalJson, sha256, toHex, utf8Encode } from "../hash.ts";
import { spansOverlap } from "../span.ts";
import { computeNewValue } from "./operators.ts";
import { copyChange, makeReceipt, validateReceipt, type Receipt } from "./receipt.ts";
import { lookupRestorer } from "./restorable.ts";
import { evaluateSelectors } from "./select.ts";
import type {
  CheckResult,
  PatchIssue,
  PinResolution,
  PlannedChange,
  ProposedChange,
  RecordAdapter,
  RecordLocator,
  RecordReader,
  RecordSource,
} from "./source.ts";
import { checkPatchAgainstAdapter, validatePatchSchema, validatePatchStructure, validatePinFingerprints, type Patch } from "./validate.ts";

export interface ApplyOptions {
  /** 跳过重复应用检测。 */
  readonly allowReapply?: boolean;
  /** 之前得到的 Receipt，用于重复应用检测。 */
  readonly receipts?: readonly unknown[];
}

export interface PlanResult {
  ok: boolean;
  issues: PatchIssue[];
  warnings: PatchIssue[];
  matches: { operationId: string; count: number }[];
  changes: PlannedChange[];
  /** 每个 pin 操作的解析结果（EXACT、RELOCATED 或冲突），按操作顺序。补丁在求值选择器之前就被拒绝时为空。 */
  pins: PinResolution[];
  /** changes 中 unchanged === false 的条目数。 */
  changedCount: number;
  /** 本次运行做过的检查及结果。补丁在打开 Record_Source 之前就被拒绝时为空。只说明检查过什么，不说明地图可以通关。 */
  checks: CheckResult[];
}

export interface ApplyResult extends PlanResult {
  output?: Uint8Array;
  receipt?: Receipt;
}

export interface RevertResult {
  ok: boolean;
  issues: PatchIssue[];
  output?: Uint8Array;
}

export function bytesHash(bytes: Uint8Array): string {
  return hashBytes(bytes);
}

function hashValidatedPatch(patch: Patch): string {
  return "sha256:" + toHex(sha256(utf8Encode(canonicalJson(patch))));
}

/** 先做结构校验（不合法时抛 TypeError，消息列出问题），再对规范 JSON 取 SHA-256。 */
export function patchHash(patch: unknown): string {
  const v = validatePatchStructure(patch);
  if (!v.ok) throw new TypeError(`invalid patch: ${v.issues.map((i) => `${i.path || "/"} ${i.message}`).join("; ")}`);
  return hashValidatedPatch(v.value);
}

export function planPatch(input: Uint8Array, patch: unknown, adapter: RecordAdapter, options: ApplyOptions = {}): PlanResult {
  // 干跑不设置 output 和 receipt
  return run(input, patch, adapter, options, true);
}

export function applyPatch(input: Uint8Array, patch: unknown, adapter: RecordAdapter, options: ApplyOptions = {}): ApplyResult {
  return run(input, patch, adapter, options, false);
}

function describe(loc: RecordLocator, field: string): string {
  return `${loc.scope} ${loc.record} #${loc.index} ${field}`;
}

function failed(issues: PatchIssue[]): ApplyResult {
  return { ok: false, issues, warnings: [], matches: [], changes: [], pins: [], changedCount: 0, checks: [] };
}

const ENGINE_CHECKS: ReadonlyArray<{ name: string; description: string; failed: (i: PatchIssue) => boolean }> = [
  {
    name: "field-conflict",
    description: "no two operations write the same field or overlapping bytes",
    failed: (i) => i.code === "CONFLICT_FIELD",
  },
  {
    name: "old-value-restorable",
    description: "every old value can be written back exactly by revert",
    failed: (i) => i.code === "VALUE_REJECTED" && i.reason === "OLD_VALUE_NOT_RESTORABLE",
  },
];

function summarizeChecks(
  source: RecordSource,
  adapter: RecordAdapter,
  issues: readonly PatchIssue[],
  warnings: readonly PatchIssue[],
  allowedProtections: ReadonlySet<string>,
  skipped: boolean,
): CheckResult[] {
  const out: CheckResult[] = ENGINE_CHECKS.map((c) => ({
    name: c.name,
    kind: "engine",
    description: c.description,
    status: issues.some(c.failed) ? "failed" : "passed",
  }));
  for (const c of source.structuralChecks ?? []) {
    const failed = issues.some((i) => i.code === "VALUE_REJECTED" && i.reason !== undefined && c.reasons.includes(i.reason));
    out.push({ name: c.name, kind: "structure", description: c.description, status: failed ? "failed" : skipped ? "incomplete" : "passed" });
  }
  for (const h of adapter.hooks) {
    const status: CheckResult["status"] = issues.some((i) => i.code === "PROTECTED" && i.hook === h.name)
      ? "failed"
      : allowedProtections.has(h.name)
        ? "allowed"
        : warnings.some((w) => w.hook === h.name)
          ? "warned"
          : "passed";
    out.push({ name: h.name, kind: "playability", description: h.description ?? h.name, status });
  }
  return out;
}

/** 只暴露读取方法的视图，交给保护钩子。 */
function readerOf(source: RecordSource): RecordReader {
  return {
    schema: source.schema,
    scopes: () => source.scopes(),
    recordCount: (scope, record) => source.recordCount(scope, record),
    readField: (loc, field) => source.readField(loc, field),
    fieldSpan: (loc, field) => source.fieldSpan(loc, field),
  };
}

function locatorOf(c: ProposedChange): RecordLocator {
  return { scope: c.scope, record: c.record, index: c.index };
}

function run(input: Uint8Array, rawPatch: unknown, adapter: RecordAdapter, options: ApplyOptions, dryRun: boolean): ApplyResult {
  // 1. 结构校验，不打开 Record_Source
  const structure = validatePatchStructure(rawPatch);
  if (!structure.ok) return failed(structure.issues);
  const patch = structure.value;
  const adapterIssues = checkPatchAgainstAdapter(patch, adapter);
  if (adapterIssues.length > 0) return failed(adapterIssues);

  // 2. 打开（adapter 负责复制输入），按 schema 校验
  const source = adapter.open(input);
  const schemaIssues = validatePatchSchema(patch, source.schema);
  if (schemaIssues.length > 0) return failed(schemaIssues);
  const fingerprintIssues = validatePinFingerprints(patch, source.fingerprints);
  if (fingerprintIssues.length > 0) return failed(fingerprintIssues);

  // 3. 回执与重复应用检测
  if (options.receipts !== undefined) {
    const receipts: Receipt[] = [];
    const receiptIssues: PatchIssue[] = [];
    options.receipts.forEach((r, i) => {
      const v = validateReceipt(r, `/receipts/${i}`);
      if (v.ok) receipts.push(v.value);
      else receiptIssues.push(...v.issues);
    });
    if (receiptIssues.length > 0) return failed(receiptIssues);
    if (!options.allowReapply && receipts.length > 0) {
      const ph = hashValidatedPatch(patch);
      const ih = hashBytes(input);
      const i = receipts.findIndex((r) => r.patchHash === ph && r.outputHash === ih);
      if (i >= 0) {
        return failed([
          {
            code: "ALREADY_APPLIED",
            message: `patch ${JSON.stringify(patch.name)} has already been applied to this input (receipt ${i}); pass allowReapply to apply it again`,
            path: `/receipts/${i}`,
          },
        ]);
      }
    }
  }

  const issues: PatchIssue[] = [];
  const warnings: PatchIssue[] = [];

  // 4. 在输入值上求值全部选择器
  const selected = evaluateSelectors(patch, source);
  issues.push(...selected.issues);
  const matches = selected.operations.map((o) => ({ operationId: o.operation.id, count: o.records.length }));

  // 5. 计算新值
  const proposed: ProposedChange[] = [];
  for (const { operation, records } of selected.operations) {
    for (const { locator, selection } of records) {
      for (const [field, change] of Object.entries(operation.change)) {
        const oldValue = source.readField(locator, field);
        proposed.push({
          operationId: operation.id,
          scope: locator.scope,
          record: locator.record,
          index: locator.index,
          field,
          oldValue,
          newValue: computeNewValue(change, oldValue),
          span: source.fieldSpan(locator, field),
          selection,
        });
      }
    }
  }

  // 6. 同一字段或物理区间重叠
  const skip = new Set<number>();
  const order = proposed.map((_, i) => i).sort((a, b) => proposed[a]!.span.start - proposed[b]!.span.start || a - b);
  for (let x = 0; x < order.length; x++) {
    const a = proposed[order[x]!]!;
    for (let y = x + 1; y < order.length; y++) {
      const b = proposed[order[y]!]!;
      if (b.span.start >= a.span.end) break;
      const same = a.scope === b.scope && a.record === b.record && a.index === b.index && a.field === b.field;
      if (!same && !spansOverlap(a.span, b.span)) continue;
      skip.add(order[x]!);
      skip.add(order[y]!);
      const [first, second] = order[x]! < order[y]! ? [a, b] : [b, a];
      issues.push({
        code: "CONFLICT_FIELD",
        message: same
          ? `operations ${first.operationId} and ${second.operationId} both write ${describe(locatorOf(second), second.field)}`
          : `${describe(locatorOf(first), first.field)} (operation ${first.operationId}) and ${describe(locatorOf(second), second.field)} (operation ${second.operationId}) overlap`,
        operationIds: [...new Set([first.operationId, second.operationId])],
        locator: locatorOf(second),
        field: second.field,
      });
    }
  }

  // 7. 旧值能否无损写回
  proposed.forEach((c, i) => {
    const loc = locatorOf(c);
    if (source.canRestore(loc, c.field)) return;
    skip.add(i);
    issues.push({
      code: "VALUE_REJECTED",
      reason: "OLD_VALUE_NOT_RESTORABLE",
      message: `${describe(loc, c.field)}: the old value has non-zero bytes after its first NUL, so revert could not restore it exactly`,
      operationId: c.operationId,
      locator: loc,
      field: c.field,
    });
  });

  // 8. 保护钩子（写入前运行，看到的是输入值）
  const allowed = new Set(patch.allowProtected ?? []);
  const allowedProtections = new Set<string>();
  const reader = readerOf(source);
  for (const c of proposed) {
    for (const hook of adapter.hooks) {
      const note = hook.check(c, reader, source.hookContext);
      if (note === null) continue;
      const loc = locatorOf(c);
      if (hook.severity === "warn") {
        warnings.push({ code: "WARNING", message: `${describe(loc, c.field)}: ${note}`, hook: hook.name, operationId: c.operationId, locator: loc, field: c.field });
      } else if (allowed.has(hook.name)) {
        allowedProtections.add(hook.name);
      } else {
        issues.push({
          code: "PROTECTED",
          message: `${describe(loc, c.field)}: ${note} (hook ${hook.name}; add it to allowProtected to opt in)`,
          hook: hook.name,
          operationId: c.operationId,
          locator: loc,
          field: c.field,
        });
      }
    }
  }

  // 9. 写入未被排除的条目，每个字段最多写一次
  const changes: PlannedChange[] = [];
  proposed.forEach((c, i) => {
    if (skip.has(i)) return;
    const loc = locatorOf(c);
    const outcome = source.writeField(loc, c.field, c.newValue);
    if (!outcome.ok) {
      issues.push({
        code: "VALUE_REJECTED",
        reason: outcome.reason,
        message: `${describe(loc, c.field)}: ${outcome.message}`,
        operationId: c.operationId,
        locator: loc,
        field: c.field,
      });
      return;
    }
    changes.push(copyChange({ ...c, unchanged: outcome.unchanged }));
  });

  // 10. 跨字段结构检查（看到的是写入后的值）；被拒绝的条目从 changes 中去掉
  if (source.checkWrites) {
    const rejected = source.checkWrites(changes.map((c) => ({ locator: locatorOf(c), field: c.field, unchanged: c.unchanged })));
    const drop = new Set<string>();
    for (const r of rejected) {
      const owner = changes.find(
        (c) => c.scope === r.locator.scope && c.record === r.locator.record && c.index === r.locator.index && c.field === r.field,
      );
      drop.add(`${r.locator.scope}\u0000${r.locator.record}\u0000${r.locator.index}\u0000${r.field}`);
      issues.push({
        code: "VALUE_REJECTED",
        reason: r.reason,
        message: `${describe(r.locator, r.field)}: ${r.message}`,
        ...(owner ? { operationId: owner.operationId } : {}),
        locator: { scope: r.locator.scope, record: r.locator.record, index: r.locator.index },
        field: r.field,
      });
    }
    if (drop.size > 0) {
      for (let i = changes.length - 1; i >= 0; i--) {
        const c = changes[i]!;
        if (drop.has(`${c.scope}\u0000${c.record}\u0000${c.index}\u0000${c.field}`)) changes.splice(i, 1);
      }
    }
  }

  const changedCount = changes.filter((c) => !c.unchanged).length;
  const checks = summarizeChecks(source, adapter, issues, warnings, allowedProtections, skip.size > 0);
  const result: ApplyResult = { ok: issues.length === 0, issues, warnings, matches, changes, pins: selected.pins, changedCount, checks };

  // 11. 无问题且非干跑：输出字节和回执
  if (!result.ok || dryRun) return result;
  const output = source.serialize();
  result.output = output;
  result.receipt = makeReceipt({
    patchName: patch.name,
    patchHash: hashValidatedPatch(patch),
    inputHash: hashBytes(input),
    outputHash: hashBytes(output),
    allowedProtections,
    entries: changes,
  });
  return result;
}

function sameValue(a: unknown, b: unknown): boolean {
  return typeof a === typeof b && a === b;
}

export function revertPatch(input: Uint8Array, rawReceipt: unknown, adapter: RecordAdapter): RevertResult {
  // 1. 白名单校验
  const v = validateReceipt(rawReceipt);
  if (!v.ok) return { ok: false, issues: v.issues };
  const receipt = v.value;

  // 2. 写回通道
  const open = lookupRestorer(adapter);
  if (!open) throw new TypeError(`adapter ${String(adapter.format)} has no registered restorer, so it cannot revert patches`);

  // 3. 输入必须是回执记录的输出
  if (hashBytes(input) !== receipt.outputHash) {
    return { ok: false, issues: [{ code: "RECEIPT_MISMATCH", message: "input hash does not match receipt.outputHash", path: "/outputHash" }] };
  }

  // 4. 逐条核对作用域、区间和新值
  const source = open(input);
  const scopeIds = new Set(source.scopes().map((s) => s.id));
  const issues: PatchIssue[] = [];
  receipt.entries.forEach((e, i) => {
    const loc: RecordLocator = { scope: e.scope, record: e.record, index: e.index };
    const mismatch = (why: string) =>
      issues.push({ code: "RECEIPT_MISMATCH", message: `${describe(loc, e.field)}: ${why}`, path: `/entries/${i}`, locator: loc, field: e.field });
    if (!scopeIds.has(e.scope)) return mismatch(`scope ${e.scope} does not exist`);
    let current: unknown;
    try {
      const s = source.fieldSpan(loc, e.field);
      if (s.start !== e.span.start || s.end !== e.span.end) return mismatch(`field span [${s.start}, ${s.end}) differs from receipt [${e.span.start}, ${e.span.end})`);
      current = source.readField(loc, e.field);
    } catch (err) {
      return mismatch(`field cannot be located (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!sameValue(current, e.newValue)) mismatch(`current value ${JSON.stringify(current)} differs from receipt newValue ${JSON.stringify(e.newValue)}`);
  });
  if (issues.length > 0) return { ok: false, issues };

  // 5. 核对全部通过后，按条目逆序写回旧值
  for (let i = receipt.entries.length - 1; i >= 0; i--) {
    const e = receipt.entries[i]!;
    const loc: RecordLocator = { scope: e.scope, record: e.record, index: e.index };
    const outcome = source.restoreField(loc, e.field, e.oldValue);
    if (!outcome.ok) {
      issues.push({
        code: "RECEIPT_MISMATCH",
        reason: outcome.reason,
        message: `${describe(loc, e.field)}: old value ${JSON.stringify(e.oldValue)} cannot be restored (${outcome.message})`,
        path: `/entries/${i}`,
        locator: loc,
        field: e.field,
      });
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  // 6. 结果必须是回执记录的输入
  const output = source.serialize();
  if (hashBytes(output) !== receipt.inputHash) {
    return { ok: false, issues: [{ code: "RECEIPT_MISMATCH", message: "reverted bytes do not match receipt.inputHash", path: "/inputHash" }] };
  }
  return { ok: true, issues: [], output };
}
