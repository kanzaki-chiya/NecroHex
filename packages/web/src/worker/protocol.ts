/**
 * 主线程和 Planner_Worker 之间的消息。字节用 Uint8Array 传递（结构化克隆），大块数据由发送方转移。
 * 这里只有数据形状，不含任何规则。
 */
import type { CheckResult, FieldValue, RelocationCandidate } from "@necrohex/core";
import type { SectorFingerprint } from "@necrohex/adapter-wad";

export type RecordKind = "Sector" | "Thing";

export interface MapEntry {
  readonly scope: string | null;
  readonly name: string;
  readonly format: "doom" | "hexen" | "udmf";
}

export interface WadSummary {
  readonly name: string;
  readonly kind: "IWAD" | "PWAD";
  readonly size: number;
  readonly sha256: string;
  /** 内置样本的版本名；用户文件为 null。 */
  readonly version: string | null;
  readonly lumpCount: number;
  readonly maps: readonly MapEntry[];
  /** PWAD 用内置样本作为基础 IWAD 时为它的文件名。 */
  readonly baseIwad: string | null;
}

export interface SectorView {
  /** SVG 路径（y 已取反），even-odd 填充。 */
  readonly d: string;
  /** 地图坐标的边界框，没有边界线段时为 null。 */
  readonly bbox: readonly [number, number, number, number] | null;
}

export interface LumpView {
  readonly lumpIndex: number;
  /** Lump 数据在文件里的偏移。 */
  readonly offset: number;
  readonly bytes: Uint8Array;
}

export interface MapData {
  readonly scope: string;
  readonly name: string;
  /** 线段端点的 [minX, minY, maxX, maxY]。 */
  readonly bounds: readonly [number, number, number, number];
  readonly sectors: readonly SectorView[];
  /** [x1, y1, x2, y2, 正面扇区, 背面扇区]，没有时为 -1。 */
  readonly lines: readonly (readonly [number, number, number, number, number, number])[];
  /** [x, y, angle, type, flags]，输入值。 */
  readonly things: readonly (readonly [number, number, number, number, number])[];
  readonly lumps: { readonly SECTORS: LumpView | null; readonly THINGS: LumpView | null };
  readonly fingerprints: readonly SectorFingerprint[];
  /** 本文件和基础 IWAD 的 Flat 名，排序，只给编辑器做候选。 */
  readonly flats: readonly string[];
}

export interface Locator {
  readonly scope: string;
  readonly record: string;
  readonly index: number;
}

export interface IssueView {
  readonly code: string;
  readonly message: string;
  /** 操作 id；CONFLICT_FIELD 为第一个。 */
  readonly op: string | null;
  readonly ops: readonly string[];
  readonly hook: string | null;
  readonly reason: string | null;
  readonly locator: Locator | null;
  readonly field: string | null;
  readonly path: string | null;
}

export interface PinView {
  readonly op: string;
  readonly map: string;
  readonly scope: string | null;
  readonly result: "EXACT" | "RELOCATED" | "CONFLICT_AMBIGUOUS" | "CONFLICT_MISSING";
  readonly expectedIndex: number;
  readonly index: number | null;
  readonly score: number | null;
  readonly fingerprintChecked: boolean;
  readonly candidates: readonly RelocationCandidate[];
  readonly message: string;
}

export interface ChangeView {
  readonly op: string;
  readonly record: string;
  readonly index: number;
  readonly field: string;
  readonly oldValue: FieldValue;
  readonly newValue: FieldValue;
  /** WHERE、ALL、EXACT 或 RELOCATED。 */
  readonly kind: string;
  readonly span: { readonly start: number; readonly end: number };
}

export interface PlanView {
  readonly seq: number;
  readonly scope: string;
  readonly ok: boolean;
  readonly patchHash: string | null;
  readonly pins: readonly PinView[];
  readonly issues: readonly IssueView[];
  readonly warnings: readonly IssueView[];
  readonly matches: readonly { readonly operationId: string; readonly count: number }[];
  /** 当前作用域里真正改变字节的条目。 */
  readonly changes: readonly ChangeView[];
  /** 每个作用域改变的字段数。 */
  readonly changedByScope: Readonly<Record<string, number>>;
  readonly changedCount: number;
  readonly checks: readonly CheckResult[];
  /** ok 时当前作用域重放后的 SECTORS、THINGS 字节。 */
  readonly after: { readonly SECTORS: Uint8Array | null; readonly THINGS: Uint8Array | null } | null;
}

export interface ReceiptView {
  readonly seq: number;
  readonly ok: boolean;
  readonly patchHash: string | null;
  readonly inputHash: string | null;
  readonly outputHash: string | null;
}

export interface ExportedMapView {
  readonly name: string;
  readonly lumps: readonly string[];
  readonly modified: boolean;
}

export type ExportView =
  | {
      readonly ok: true;
      readonly pwad: Uint8Array;
      readonly pwadSha256: string;
      readonly receiptJson: string;
      readonly receipt: { readonly patchHash: string; readonly inputHash: string; readonly outputHash: string; readonly entries: number };
      readonly maps: readonly ExportedMapView[];
      readonly exportChecks: readonly string[];
      readonly checks: readonly CheckResult[];
      readonly changedCount: number;
    }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly issues: readonly IssueView[] };

export interface OpenRequest {
  readonly type: "open";
  readonly name: string;
  readonly bytes: Uint8Array;
  /** 内置样本：哈希必须相等，之后它也作为 PWAD 的基础 IWAD。 */
  readonly sample?: { readonly sha256: string; readonly version: string };
}

export type Request =
  | OpenRequest
  | { readonly type: "map"; readonly scope: string }
  | { readonly type: "plan"; readonly seq: number; readonly patch: unknown; readonly scope: string }
  | { readonly type: "status"; readonly patches: readonly unknown[] }
  | { readonly type: "receipt"; readonly seq: number; readonly patch: unknown }
  | { readonly type: "export"; readonly patch: unknown };

export type ResponseBody =
  | { readonly type: "open"; readonly summary: WadSummary }
  | { readonly type: "map"; readonly map: MapData }
  | { readonly type: "plan"; readonly plan: PlanView }
  | { readonly type: "status"; readonly ok: readonly boolean[] }
  | { readonly type: "receipt"; readonly receipt: ReceiptView }
  | { readonly type: "export"; readonly result: ExportView }
  /** 有更新的规划请求，这个请求没有处理。 */
  | { readonly type: "stale" }
  | { readonly type: "error"; readonly code: string; readonly message: string };

export interface Envelope<T> {
  readonly id: number;
  readonly body: T;
}
