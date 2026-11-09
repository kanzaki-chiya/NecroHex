/**
 * 补丁引擎与具体格式之间的记录接口。core 只经这里读写记录，不认识任何文件格式。
 * 定位一律是"作用域 + 记录 + 下标 + 字段"，没有裸偏移。
 */
import type { Span } from "../span.ts";

export type FieldValue = number | string;

/** int 和 name 可选择、可修改；other 既不可选择也不可修改。 */
export type FieldKind = "int" | "name" | "other";

export interface RecordSchema {
  readonly [record: string]: { readonly writable: boolean; readonly fields: Readonly<Record<string, FieldKind>> };
}

/** scope 为作用域 id。 */
export interface RecordLocator {
  readonly scope: string;
  readonly record: string;
  readonly index: number;
}

export type WriteOutcome =
  | { readonly ok: true; readonly span: Span; readonly unchanged: boolean }
  | { readonly ok: false; readonly reason: string; readonly message: string };

export interface RecordScope {
  /** 唯一。 */
  readonly id: string;
  /** 可重复。 */
  readonly name: string;
}

export interface RecordReader {
  readonly schema: RecordSchema;
  /** 按目录顺序。 */
  scopes(): readonly RecordScope[];
  /** 缺该 Lump 时为 0。 */
  recordCount(scope: string, record: string): number;
  readField(loc: RecordLocator, field: string): FieldValue;
  fieldSpan(loc: RecordLocator, field: string): Span;
}

export interface RecordSource extends RecordReader {
  /** 旧值能否经写回通道无损写回。 */
  canRestore(loc: RecordLocator, field: string): boolean;
  /** 写入新值，做完整校验。 */
  writeField(loc: RecordLocator, field: string, value: FieldValue): WriteOutcome;
  serialize(): Uint8Array;
}

export type Selection =
  | { readonly kind: "WHERE" }
  | { readonly kind: "ALL" }
  | { readonly kind: "EXACT"; readonly expectedIndex: number; readonly fingerprintChecked: false };

export interface ProposedChange {
  readonly operationId: string;
  readonly scope: string;
  readonly record: string;
  readonly index: number;
  readonly field: string;
  readonly oldValue: FieldValue;
  readonly newValue: FieldValue;
  readonly span: Span;
  readonly selection: Selection;
}

export interface PlannedChange extends ProposedChange {
  /** 新值编码后的字节与字段当前字节逐字节相同。 */
  readonly unchanged: boolean;
}

export interface ProtectionHook {
  readonly name: string;
  readonly severity: "block" | "warn";
  /** 触发时返回说明，否则返回 null。 */
  check(change: ProposedChange, reader: RecordReader): string | null;
}

export interface RecordAdapter {
  readonly format: string;
  readonly hooks: readonly ProtectionHook[];
  /** 必须复制输入。 */
  open(input: Uint8Array): RecordSource;
}

export type PatchIssueCode =
  | "INVALID_PATCH"
  | "INVALID_RECEIPT"
  | "VALUE_REJECTED"
  | "CONFLICT_FIELD"
  | "CONFLICT_MISSING"
  | "CONFLICT_AMBIGUOUS"
  | "PROTECTED"
  | "ALREADY_APPLIED"
  | "RECEIPT_MISMATCH";

export interface PatchIssue {
  readonly code: PatchIssueCode | "WARNING";
  readonly message: string;
  readonly operationId?: string;
  readonly operationIds?: string[];
  /** JSON Pointer。 */
  readonly path?: string;
  readonly locator?: RecordLocator;
  readonly field?: string;
  readonly hook?: string;
  readonly reason?: string;
}
