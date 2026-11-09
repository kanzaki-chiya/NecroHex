import { complementSpans, mergeSpans, span, spansOverlap, type Span } from "@necrohex/core";
import { ByteOverlay } from "@necrohex/core/internal";
import { fieldByteLength, FIELD_TYPE_SIZE, type FieldLayout } from "./field-codec.ts";
import { installRestore } from "./restore-channel.ts";
import {
  RECORD_LAYOUTS,
  RECORD_READERS,
  type RecordName,
  type RecordTypes,
} from "./generated/records.ts";
import * as generated from "./generated/records.ts";

export const HEADER_SIZE = 12;
export const DIRECTORY_ENTRY_SIZE = 16;

export type WadKind = "IWAD" | "PWAD";

export type WadParseErrorCode = "TOO_SHORT" | "BAD_IDENT" | "BAD_DIRECTORY";

/** 只在无法定位目录时抛出。其他异常的历史数据一律记入 issues，不拒绝。 */
export class WadParseError extends Error {
  readonly code: WadParseErrorCode;
  constructor(code: WadParseErrorCode, message: string) {
    super(message);
    this.name = "WadParseError";
    this.code = code;
  }
}

export type WadRecordErrorCode =
  /** 属于非 Doom 格式地图的 Lump，记录接口拒绝按 Doom 布局访问。 */
  | "UNSUPPORTED_MAP_FORMAT"
  /** setField 的目标 Lump 不属于任何已识别的地图作用域（读取不受影响）。 */
  | "OUTSIDE_MAP_SCOPE"
  /** setField 的目标字段与文件头、目录或其他 Lump 的数据区间相交。 */
  | "WRITE_OVERLAPS_STRUCTURE";

/**
 * 调用参数合法，但文件结构不允许这次记录操作。
 * 参数类错误仍是 TypeError / RangeError；解析阶段不会抛出它。
 */
export class WadRecordError extends Error {
  readonly code: WadRecordErrorCode;
  /** 触发错误的 Lump 下标。 */
  readonly lumpIndex: number;
  constructor(code: WadRecordErrorCode, lumpIndex: number, message: string) {
    super(message);
    this.name = "WadRecordError";
    this.code = code;
    this.lumpIndex = lumpIndex;
  }
}

export type LumpIssueCode = "NEGATIVE_FIELD" | "DATA_OUT_OF_BOUNDS";

export interface LumpEntry {
  readonly index: number;
  /** 到第一个 NUL 为止、按 latin1 解码的名称。原始 8 字节在 nameSpan。 */
  readonly name: string;
  readonly filepos: number;
  readonly size: number;
  /** 目录项本身的 16 字节。 */
  readonly entrySpan: Span;
  /** 目录项中原始名称的 8 字节。 */
  readonly nameSpan: Span;
  /** 数据区间；大小为 0 或数据不在文件内时为 null。 */
  readonly dataSpan: Span | null;
  /** 大小为 0 的标记 Lump。 */
  readonly isMarker: boolean;
  readonly issues: readonly LumpIssueCode[];
}

/** 标准地图数据 Lump。出现在标记之后，视为该地图的作用域。 */
export const MAP_DATA_LUMPS: readonly string[] = [
  "THINGS",
  "LINEDEFS",
  "SIDEDEFS",
  "VERTEXES",
  "SEGS",
  "SSECTORS",
  "NODES",
  "SECTORS",
  "REJECT",
  "BLOCKMAP",
];

/** Doom/Hexen 路径额外接受的成员：Hexen 的脚本字节码。 */
const MAP_EXTRA_LUMPS: readonly string[] = ["BEHAVIOR", "SCRIPTS"];

/** UDMF 路径的成员。以 TEXTMAP 开头，以 ENDMAP 结束且包含它。名称启发式，不保证覆盖所有来源的 WAD。 */
const UDMF_MAP_LUMPS: readonly string[] = ["TEXTMAP", "ZNODES", "REJECT", "DIALOGUE", "BEHAVIOR", "SCRIPTS", "BLOCKMAP", "ENDMAP"];

const MAP_MARKER = /^(E[1-9]M[1-9]|MAP\d\d)$/;

/**
 * 地图格式，只识别、不解析：作用域含 TEXTMAP 为 udmf，否则含 BEHAVIOR 为 hexen，其余为 doom。
 * 记录接口只按 Doom 布局解释 Lump，所以只有 doom 地图的记录可访问。
 */
export type MapFormat = "doom" | "hexen" | "udmf";

export interface MapScope {
  readonly name: string;
  readonly format: MapFormat;
  readonly markerIndex: number;
  /** 标记之后的数据 Lump 下标，按目录顺序。 */
  readonly dataIndices: readonly number[];
  /** 数据 Lump 名称到目录下标的映射。 */
  readonly lumps: Readonly<Record<string, number>>;
}

export interface WadRegions {
  readonly header: Span;
  readonly directory: Span | null;
  readonly lumpData: readonly Span[];
  /** 不属于头、目录或任何 Lump 的字节，原样保留。 */
  readonly gaps: readonly Span[];
}

const WRITABLE_RECORDS: ReadonlySet<RecordName> = new Set<RecordName>(["Sector", "Thing"]);

function decodeName(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * 旧值的类型域编码，只供 #restoreField 使用，不导出。
 * int16 / uint16：类型范围内的整数。name8：长 0 到 8、码元 0x01–0xFF 的字符串，按 latin1 写入并补 NUL。
 * 不做新值的额外限制（可打印 ASCII、至少 1 个字符），因为旧值来自原文件。
 */
function encodeRestoreValue(layout: FieldLayout, label: string, value: unknown): Uint8Array {
  if (layout.count !== 1) throw new TypeError(`${label}: only single-value fields can be restored`);
  const out = new Uint8Array(FIELD_TYPE_SIZE[layout.type]);
  if (layout.type === "name8") {
    if (typeof value !== "string") throw new TypeError(`${label}: expected a string`);
    if (value.length > 8) throw new RangeError(`${label}: name must be at most 8 characters`);
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c < 0x01 || c > 0xff) throw new RangeError(`${label}: character code ${c} is outside 0x01..0xFF`);
      out[i] = c;
    }
    return out;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) throw new TypeError(`${label}: expected an integer`);
  const [min, max] = layout.type === "int16" ? [-32768, 32767] : [0, 65535];
  if (value < min || value > max) throw new RangeError(`${label}: ${value} is outside ${layout.type} range ${min}..${max}`);
  const v = new DataView(out.buffer);
  if (layout.type === "int16") v.setInt16(0, value, true);
  else v.setUint16(0, value, true);
  return out;
}

export class WadFile {
  readonly kind: WadKind;
  readonly numLumps: number;
  readonly directoryOffset: number;
  readonly lumps: readonly LumpEntry[];
  readonly maps: readonly MapScope[];
  readonly regions: WadRegions;
  readonly #overlay: ByteOverlay;
  /** 数据 Lump 下标 → 以它为数据 Lump 的地图作用域；没有条目表示不属于任何作用域。 */
  readonly #scopesByLump: ReadonlyMap<number, readonly MapScope[]>;

  private constructor(
    overlay: ByteOverlay,
    kind: WadKind,
    numLumps: number,
    directoryOffset: number,
    lumps: LumpEntry[],
  ) {
    this.#overlay = overlay;
    this.kind = kind;
    this.numLumps = numLumps;
    this.directoryOffset = directoryOffset;
    this.lumps = lumps;
    this.maps = scopeMaps(lumps);
    const scopesByLump = new Map<number, MapScope[]>();
    for (const m of this.maps) {
      for (const i of m.dataIndices) scopesByLump.set(i, [...(scopesByLump.get(i) ?? []), m]);
    }
    this.#scopesByLump = scopesByLump;
    this.regions = computeRegions(overlay.length, numLumps, directoryOffset, lumps);
  }

  /**
   * 解析 WAD 字节。入口先复制输入，之后 WadFile 与调用方的数组再无关联：
   * 调用方此后修改输入不影响 serialize()、original() 和 lumpBytes()。
   * 用 new Uint8Array(input) 而不是 input.slice()：Node 的 Buffer.slice 返回同一内存的视图，不会复制。
   */
  static parse(input: Uint8Array): WadFile {
    const bytes = new Uint8Array(input);
    if (bytes.length < HEADER_SIZE) throw new WadParseError("TOO_SHORT", "file is shorter than the 12-byte header");
    const ident = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
    if (ident !== "IWAD" && ident !== "PWAD") throw new WadParseError("BAD_IDENT", `unknown identification ${JSON.stringify(ident)}`);
    const v = view(bytes);
    const numLumps = v.getInt32(4, true);
    const dirOfs = v.getInt32(8, true);
    if (numLumps < 0) throw new WadParseError("BAD_DIRECTORY", `negative lump count ${numLumps}`);
    if (numLumps > 0) {
      if (dirOfs < 0 || dirOfs + numLumps * DIRECTORY_ENTRY_SIZE > bytes.length) {
        throw new WadParseError("BAD_DIRECTORY", `directory at ${dirOfs} with ${numLumps} entries does not fit in ${bytes.length} bytes`);
      }
    }
    const lumps: LumpEntry[] = [];
    for (let i = 0; i < numLumps; i++) {
      const at = dirOfs + i * DIRECTORY_ENTRY_SIZE;
      const filepos = v.getInt32(at, true);
      const size = v.getInt32(at + 4, true);
      const issues: LumpIssueCode[] = [];
      let dataSpan: Span | null = null;
      if (filepos < 0 || size < 0) {
        issues.push("NEGATIVE_FIELD");
      } else if (size > 0) {
        if (filepos + size > bytes.length) issues.push("DATA_OUT_OF_BOUNDS");
        else dataSpan = span(filepos, size);
      }
      lumps.push({
        index: i,
        name: decodeName(bytes.subarray(at + 8, at + 16)),
        filepos,
        size,
        entrySpan: span(at, DIRECTORY_ENTRY_SIZE),
        nameSpan: span(at + 8, 8),
        dataSpan,
        isMarker: size === 0,
        issues,
      });
    }
    return new WadFile(new ByteOverlay(bytes), ident, numLumps, dirOfs, lumps);
  }

  /**
   * 解析时输入的副本，不含任何 setField 写入。每次调用返回新数组（一次 O(n) 拷贝），
   * 修改返回值不影响 WadFile。用于测试、夹具脚本和差异比较，不适合热路径。
   */
  original(): Uint8Array {
    return this.#overlay.baseCopy();
  }

  /** 自解析以来写入过的区间。 */
  dirtySpans(): Span[] {
    return this.#overlay.dirtySpans();
  }

  /** 无修改时与输入逐字节相同；有修改时只有脏区间不同。 */
  serialize(): Uint8Array {
    return this.#overlay.materialize();
  }

  /** 读取 Lump 的当前字节（含已写入的修改）。 */
  lumpBytes(lumpIndex: number): Uint8Array {
    const s = this.#lump(lumpIndex).dataSpan;
    return s ? this.#overlay.read(s.start, s.end - s.start) : new Uint8Array(0);
  }

  findLump(name: string, from = 0): LumpEntry | undefined {
    const want = name.toUpperCase();
    for (let i = from; i < this.lumps.length; i++) if (this.lumps[i]!.name.toUpperCase() === want) return this.lumps[i];
    return undefined;
  }

  findMap(name: string): MapScope | undefined {
    const want = name.toUpperCase();
    return this.maps.find((m) => m.name.toUpperCase() === want);
  }

  /** 该地图的记录 Lump，例如 mapLump(map, "SECTORS")。 */
  mapLump(map: MapScope, lumpName: string): LumpEntry | undefined {
    const i = map.lumps[lumpName.toUpperCase()];
    return i === undefined ? undefined : this.lumps[i];
  }

  /** 记录数量。大小不是整数倍时，尾部余字节不计入记录。 */
  recordCount(lumpIndex: number, record: RecordName): number {
    const lump = this.#recordLump(lumpIndex, record);
    return Math.floor((lump.dataSpan ? lump.size : 0) / RECORD_LAYOUTS[record].size);
  }

  recordSpan(lumpIndex: number, record: RecordName, index: number): Span {
    const lump = this.#recordLump(lumpIndex, record);
    const size = RECORD_LAYOUTS[record].size;
    if (!lump.dataSpan || !Number.isInteger(index) || index < 0 || (index + 1) * size > lump.size) {
      throw new RangeError(`${record} #${index} does not exist in lump ${lump.name}`);
    }
    return span(lump.dataSpan.start + index * size, size);
  }

  /** 单个字段的物理区间。 */
  fieldSpan<K extends RecordName>(lumpIndex: number, record: K, index: number, field: keyof RecordTypes[K] & string): Span {
    const rec = this.recordSpan(lumpIndex, record, index);
    const fields = RECORD_LAYOUTS[record].fields as Record<string, { offset: number; type: "int16" | "uint16" | "name8"; count: number }>;
    // 只接受布局自有的字段：constructor、toString、__proto__ 等继承名称不是字段
    if (!Object.hasOwn(fields, field)) throw new RangeError(`${record} has no field ${field}`);
    const layout = fields[field]!;
    return span(rec.start + layout.offset, fieldByteLength(layout));
  }

  readRecord<K extends RecordName>(lumpIndex: number, record: K, index: number): RecordTypes[K] {
    const s = this.recordSpan(lumpIndex, record, index);
    const bytes = this.#overlay.read(s.start, s.end - s.start);
    return RECORD_READERS[record](view(bytes), 0);
  }

  readRecords<K extends RecordName>(lumpIndex: number, record: K): RecordTypes[K][] {
    const n = this.recordCount(lumpIndex, record);
    const out: RecordTypes[K][] = [];
    for (let i = 0; i < n; i++) out.push(this.readRecord(lumpIndex, record, i));
    return out;
  }

  /**
   * 写入一个新的字段值，返回被改写的物理区间。
   * 只允许 Sector 和 Thing；值先通过类型和范围校验，原始字节不会被重新解释。
   * 检查顺序：记录类型 → 位置与字段名 → 新值 → 地图作用域 → 写入重叠；任何一步失败都尚未写入，不留痕迹。
   * 参数类错误（TypeError / RangeError）先于结构类拒绝（WadRecordError）报告。
   * 目标 Lump 不属于任何地图作用域时抛 WadRecordError(OUTSIDE_MAP_SCOPE)；读取接口不做这项检查。
   * 目标字段区间与文件头、目录或其他 Lump 的数据区间相交时抛 WadRecordError(WRITE_OVERLAPS_STRUCTURE)。
   */
  setField<K extends RecordName, F extends keyof RecordTypes[K] & string>(
    lumpIndex: number,
    record: K,
    index: number,
    field: F,
    value: RecordTypes[K][F],
  ): Span {
    return this.#writeEncoded(lumpIndex, record, index, field, () => {
      const encode = (generated as unknown as Record<string, (f: string, v: unknown) => Uint8Array>)[`encode${record}Field`];
      if (!encode) throw new Error(`no encoder for ${record}`);
      return encode(field, value);
    });
  }

  static {
    // 写回通道：把调用私有 #restoreField 的闭包交给 restore-channel.ts（只接受一次），不经任何入口导出
    installRestore((wad, lumpIndex, record, index, field, value) => wad.#restoreField(lumpIndex, record, index, field, value));
  }

  /**
   * 撤销时写回旧值。与 setField 走同一条 #writeEncoded（只读、位置、作用域、结构重叠检查完全相同），
   * 值只做类型域检查（encodeRestoreValue），因为旧值来自原文件，可能是新值校验不接受的历史数据。
   */
  #restoreField(lumpIndex: number, record: string, index: number, field: string, value: unknown): Span {
    if (!Object.hasOwn(RECORD_LAYOUTS, record)) throw new TypeError(`unknown record type ${record}`);
    const rec = record as RecordName;
    return this.#writeEncoded(lumpIndex, rec, index, field, () => {
      const fields = RECORD_LAYOUTS[rec].fields as Record<string, FieldLayout>;
      return encodeRestoreValue(fields[field]!, `${record}.${field}`, value);
    });
  }

  /**
   * 写入的公共路径。检查顺序：记录类型 → 位置与字段名 → 值（encode 回调）→ 地图作用域 → 写入重叠；任何一步失败都尚未写入。
   */
  #writeEncoded(lumpIndex: number, record: RecordName, index: number, field: string, encode: () => Uint8Array): Span {
    if (!WRITABLE_RECORDS.has(record)) throw new Error(`${record} records are read-only`);
    const target = this.fieldSpan(lumpIndex, record, index, field as never);
    const bytes = encode();
    if (bytes.length !== target.end - target.start) throw new Error(`encoded ${record}.${field} has ${bytes.length} bytes, expected ${target.end - target.start}`);
    // 作用域规则：不属于任何地图作用域的 Lump 可读不可写。写入必须能证明目标属于一张已识别的地图，
    // 记录大小和字段偏移才有依据。作用域识别是名称启发式，误判的方向是拒绝写入，而不是错误写入。
    // 落入任一非 Doom 作用域的 Lump 已在前面的 fieldSpan 里被拒绝（UNSUPPORTED_MAP_FORMAT，优先于本检查），
    // 所以能走到这里并通过检查的，至少属于一个 Doom 作用域。
    // 同一 Lump 落入多个作用域只可能出现在病态输入里；按现有扫描规则，每个数据 Lump 只跟随最近的标记，
    // 目前构造不出这种输入，所以这条规则是防御性的，没有对应测试。
    if (!this.#scopesByLump.has(lumpIndex)) {
      throw new WadRecordError(
        "OUTSIDE_MAP_SCOPE",
        lumpIndex,
        `lump ${lumpIndex} (${this.#lump(lumpIndex).name}) is not inside any recognized map scope, so it is read-only`,
      );
    }
    this.#assertNoStructureOverlap(lumpIndex, target);
    return this.#overlay.write(target.start, bytes);
  }

  /**
   * 目标区间不得与头、目录或自己以外的 Lump 的非空数据区间相交。
   * 半开区间：首尾相接不算相交。只比较目标字段，不比较被写 Lump 的整个数据区间。
   */
  #assertNoStructureOverlap(lumpIndex: number, target: Span): void {
    const reject = (what: string): never => {
      throw new WadRecordError(
        "WRITE_OVERLAPS_STRUCTURE",
        lumpIndex,
        `write [${target.start}, ${target.end}) in lump ${lumpIndex} overlaps ${what}`,
      );
    };
    if (spansOverlap(target, this.regions.header)) reject("the header");
    if (this.regions.directory && spansOverlap(target, this.regions.directory)) reject("the directory");
    for (const l of this.lumps) {
      if (l.index !== lumpIndex && l.dataSpan && spansOverlap(target, l.dataSpan)) reject(`lump ${l.index} (${l.name})`);
    }
  }

  #lump(i: number): LumpEntry {
    const l = this.lumps[i];
    if (!l) throw new RangeError(`no lump at index ${i}`);
    return l;
  }

  /**
   * 六个记录接口共用的入口检查，顺序：Lump 下标存在 → Lump 名称与记录类型相符 → 地图格式。
   * 记录布局只有 Doom 一种；落入任一非 Doom 作用域的 Lump 一律拒绝，不在多个格式之间猜测。
   * 不属于任何作用域的 Lump 不在这里处理：读取照常，写入由 setField 的作用域检查拒绝。
   */
  #recordLump(i: number, record: RecordName): LumpEntry {
    const l = this.#lump(i);
    if (l.name.toUpperCase() !== RECORD_LAYOUTS[record].lump) {
      throw new TypeError(`lump ${l.name} does not hold ${record} records (expected ${RECORD_LAYOUTS[record].lump})`);
    }
    const foreign = this.#scopesByLump.get(i)?.find((m) => m.format !== "doom");
    if (foreign) {
      throw new WadRecordError(
        "UNSUPPORTED_MAP_FORMAT",
        i,
        `lump ${l.name} belongs to ${foreign.format} map ${foreign.name}; ${record} records are only supported in Doom-format maps`,
      );
    }
    return l;
  }
}

/**
 * 从标记之后连续收集成员 Lump：遇到非成员或本地图内已出现过的名称就结束；
 * stopAfter 指定的名称被收集后立即结束（UDMF 的 ENDMAP）。
 */
function collectMembers(
  lumps: readonly LumpEntry[],
  from: number,
  members: ReadonlySet<string>,
  stopAfter?: string,
): { dataIndices: number[]; byName: Record<string, number> } {
  const dataIndices: number[] = [];
  const byName: Record<string, number> = {};
  for (let j = from; j < lumps.length; j++) {
    const n = lumps[j]!.name.toUpperCase();
    if (!members.has(n) || Object.hasOwn(byName, n)) break;
    byName[n] = j;
    dataIndices.push(j);
    if (n === stopAfter) break;
  }
  return { dataIndices, byName };
}

function scopeMaps(lumps: readonly LumpEntry[]): MapScope[] {
  const doomMembers = new Set([...MAP_DATA_LUMPS, ...MAP_EXTRA_LUMPS]);
  const udmfMembers = new Set(UDMF_MAP_LUMPS);
  const maps: MapScope[] = [];
  for (let i = 0; i < lumps.length; i++) {
    const marker = lumps[i]!;
    const name = marker.name.toUpperCase();
    if (lumps[i + 1]?.name.toUpperCase() === "TEXTMAP") {
      // UDMF：标记是紧邻 TEXTMAP 之前的 Lump，名称不受 ExMy / MAPxx 限制，也不要求大小为 0。
      // 缺少 ENDMAP 的作用域仍识别为 udmf，在第一个非成员或重复名称处结束。
      const { dataIndices, byName } = collectMembers(lumps, i + 1, udmfMembers, "ENDMAP");
      maps.push({ name: marker.name, format: "udmf", markerIndex: i, dataIndices, lumps: byName });
    } else if (MAP_MARKER.test(name)) {
      // Doom / Hexen：至少含一个标准数据 Lump 才成图，只含 BEHAVIOR / SCRIPTS 的候选不成图
      const { dataIndices, byName } = collectMembers(lumps, i + 1, doomMembers);
      if (!MAP_DATA_LUMPS.some((n) => Object.hasOwn(byName, n))) continue;
      const format: MapFormat = Object.hasOwn(byName, "BEHAVIOR") ? "hexen" : "doom";
      maps.push({ name: marker.name, format, markerIndex: i, dataIndices, lumps: byName });
    }
  }
  return maps;
}

function computeRegions(total: number, numLumps: number, dirOfs: number, lumps: readonly LumpEntry[]): WadRegions {
  const header = span(0, HEADER_SIZE);
  const directory = numLumps > 0 ? span(dirOfs, numLumps * DIRECTORY_ENTRY_SIZE) : null;
  const lumpData = mergeSpans(lumps.flatMap((l) => (l.dataSpan ? [l.dataSpan] : [])));
  const covered = [header, ...(directory ? [directory] : []), ...lumpData];
  return { header, directory, lumpData, gaps: complementSpans(total, covered) };
}
