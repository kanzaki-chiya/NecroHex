import { ByteOverlay, complementSpans, mergeSpans, span, type Span } from "@necrohex/core";
import { fieldByteLength } from "./field-codec.ts";
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

const MAP_MARKER = /^(E[1-9]M[1-9]|MAP\d\d)$/;

export interface MapScope {
  readonly name: string;
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

export class WadFile {
  readonly kind: WadKind;
  readonly numLumps: number;
  readonly directoryOffset: number;
  readonly lumps: readonly LumpEntry[];
  readonly maps: readonly MapScope[];
  readonly regions: WadRegions;
  readonly #overlay: ByteOverlay;

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
    this.regions = computeRegions(overlay.base.length, numLumps, directoryOffset, lumps);
  }

  static parse(bytes: Uint8Array): WadFile {
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

  /** 解析时的只读原始缓冲。 */
  get baseBuffer(): Uint8Array {
    return this.#overlay.base;
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
    const layout = (RECORD_LAYOUTS[record].fields as Record<string, { offset: number; type: "int16" | "uint16" | "name8"; count: number }>)[field];
    if (!layout) throw new RangeError(`${record} has no field ${field}`);
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
   */
  setField<K extends RecordName, F extends keyof RecordTypes[K] & string>(
    lumpIndex: number,
    record: K,
    index: number,
    field: F,
    value: RecordTypes[K][F],
  ): Span {
    if (!WRITABLE_RECORDS.has(record)) throw new Error(`${record} records are read-only`);
    const target = this.fieldSpan(lumpIndex, record, index, field);
    const encode = (generated as unknown as Record<string, (f: string, v: unknown) => Uint8Array>)[`encode${record}Field`];
    if (!encode) throw new Error(`no encoder for ${record}`);
    return this.#overlay.write(target.start, encode(field, value));
  }

  #lump(i: number): LumpEntry {
    const l = this.lumps[i];
    if (!l) throw new RangeError(`no lump at index ${i}`);
    return l;
  }

  #recordLump(i: number, record: RecordName): LumpEntry {
    const l = this.#lump(i);
    if (l.name.toUpperCase() !== RECORD_LAYOUTS[record].lump) {
      throw new TypeError(`lump ${l.name} does not hold ${record} records (expected ${RECORD_LAYOUTS[record].lump})`);
    }
    return l;
  }
}

function scopeMaps(lumps: readonly LumpEntry[]): MapScope[] {
  const dataNames = new Set(MAP_DATA_LUMPS);
  const maps: MapScope[] = [];
  for (let i = 0; i < lumps.length; i++) {
    const marker = lumps[i]!;
    const name = marker.name.toUpperCase();
    if (!MAP_MARKER.test(name)) continue;
    const dataIndices: number[] = [];
    const byName: Record<string, number> = {};
    for (let j = i + 1; j < lumps.length; j++) {
      const n = lumps[j]!.name.toUpperCase();
      if (!dataNames.has(n) || n in byName) break;
      byName[n] = j;
      dataIndices.push(j);
    }
    if (dataIndices.length > 0) maps.push({ name: marker.name, markerIndex: i, dataIndices, lumps: byName });
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
