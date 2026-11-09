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

/** 一项检查的说明。name 在同一 adapter 内唯一。 */
export interface CheckInfo {
  readonly name: string;
  readonly description: string;
}

/** 结构检查：拒绝时 writeField 或 checkWrites 返回的 reason 属于 reasons。 */
export interface StructuralCheck extends CheckInfo {
  readonly reasons: readonly string[];
}

/** checkWrites 返回的拒绝：哪条记录的哪个字段、什么原因。 */
export interface WriteRejection {
  readonly locator: RecordLocator;
  readonly field: string;
  readonly reason: string;
  readonly message: string;
}

export interface RecordSource extends RecordReader {
  /** 旧值能否经写回通道无损写回。 */
  canRestore(loc: RecordLocator, field: string): boolean;
  /** 写入新值，做完整校验。只校验新值，不因记录里已有的非常规数据拒绝。 */
  writeField(loc: RecordLocator, field: string, value: FieldValue): WriteOutcome;
  /**
   * 全部写入之后的跨字段结构检查（例如同一记录两个字段之间的约束）。
   * written 是本次成功写入的字段；只应检查其中实际改变的值所涉及的约束。
   */
  checkWrites?(written: readonly { readonly locator: RecordLocator; readonly field: string; readonly unchanged: boolean }[]): readonly WriteRejection[];
  /** writeField 与 checkWrites 执行的结构检查，用于报告。 */
  readonly structuralChecks?: readonly StructuralCheck[];
  /** 交给保护钩子的格式相关上下文，core 不解释它。 */
  readonly hookContext?: unknown;
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
  /** 报告里列出的说明。 */
  readonly description?: string;
  /** 触发时返回说明，否则返回 null。context 是 RecordSource.hookContext。 */
  check(change: ProposedChange, reader: RecordReader, context?: unknown): string | null;
}

/**
 * 一项检查在本次运行中的结果。
 * passed：参与检查的条目都没有触发；failed：有条目被拒绝；warned：警告类检查触发了；
 * allowed：拦截类检查触发了，但补丁在 allowProtected 中显式放行；
 * incomplete：有条目在这项检查之前就被排除，没有经过它。
 * 这些结果只说明做过哪些静态检查，不说明地图可以通关。
 */
export interface CheckResult {
  readonly name: string;
  readonly kind: "engine" | "structure" | "playability";
  readonly description: string;
  readonly status: "passed" | "failed" | "warned" | "allowed" | "incomplete";
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
