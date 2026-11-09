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
  /** pin 的语义指纹。没有时，带 fingerprint 的 pin 一律为 INVALID_PATCH。 */
  readonly fingerprints?: RecordFingerprints;
}

/** fingerprint 校验问题。path 是相对 pin.fingerprint 的 JSON Pointer。 */
export interface FingerprintProblem {
  readonly path: string;
  readonly message: string;
}

/**
 * 格式相关的语义指纹。core 不解释指纹的内容，只按相似度分级（见 relocate.ts）。
 * 相似度按输入值计算，与补丁的写入无关。
 */
export interface RecordFingerprints {
  /** 支持指纹的记录类型。 */
  readonly records: readonly string[];
  /** 校验 pin.fingerprint 的形状；空数组表示合法。只会对 records 中的记录类型调用。 */
  validate(record: string, fingerprint: unknown): readonly FingerprintProblem[];
  /** 记录当前的指纹（JSON 值），用于编写补丁和报告。 */
  compute(loc: RecordLocator): unknown;
  /** 作用域内每条记录与 expected 的相似度，数组下标即记录下标，取值在 [0, 1]，1 表示完全一致。 */
  scores(scope: string, record: string, expected: unknown): readonly number[];
}

/** 一个重定位候选：记录下标和相似度（保留 4 位小数）。 */
export interface RelocationCandidate {
  readonly index: number;
  readonly score: number;
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

/**
 * 选中一条记录的方式。pin 没有 fingerprint 时只能按下标选中，fingerprintChecked 为 false；
 * 有 fingerprint 时 fingerprintChecked 为 true，score 是被选中记录的相似度。
 */
export type Selection =
  | { readonly kind: "WHERE" }
  | { readonly kind: "ALL" }
  | { readonly kind: "EXACT"; readonly expectedIndex: number; readonly fingerprintChecked: false }
  | { readonly kind: "EXACT"; readonly expectedIndex: number; readonly fingerprintChecked: true; readonly score: number }
  | { readonly kind: "RELOCATED"; readonly expectedIndex: number; readonly fingerprintChecked: true; readonly score: number };

/** 一个 pin 的解析结果。 */
export interface PinResolution {
  readonly operationId: string;
  readonly map: string;
  readonly record: string;
  readonly expectedIndex: number;
  readonly result: "EXACT" | "RELOCATED" | "CONFLICT_AMBIGUOUS" | "CONFLICT_MISSING";
  /** 作用域 id；地图不存在或重名时没有。 */
  readonly scope?: string;
  /** 实际选中的下标；冲突时没有。 */
  readonly index?: number;
  readonly fingerprintChecked: boolean;
  /** 选中记录的相似度；没有校验指纹或冲突时没有。 */
  readonly score?: number;
  /** 相似度达到下限的候选，按相似度降序、下标升序，最多 10 个。 */
  readonly candidates: readonly RelocationCandidate[];
  /** 达到下限的候选总数。 */
  readonly candidateCount: number;
  readonly message: string;
}

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
  /**
   * 可选的整体检查，用于取决于多条改动写入后取值的规则。在逐条 check 之后调用一次。
   * changes 是全部参与写入的拟议改动；after 读出这些改动全部写入后的值，其余字段为输入值。
   * 每条结果挂在 changes 中的一条改动上（必须是同一个对象），按 severity 报告为警告或拦截。
   */
  checkPatch?(changes: readonly ProposedChange[], after: RecordReader, context?: unknown): readonly HookFinding[];
}

/** checkPatch 的一条结果。 */
export interface HookFinding {
  readonly change: ProposedChange;
  readonly message: string;
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
  /** CONFLICT_AMBIGUOUS、CONFLICT_MISSING 的重定位候选。 */
  readonly candidates?: readonly RelocationCandidate[];
}
