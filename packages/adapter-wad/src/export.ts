import { mergeSpans, spanWithin, spansOverlap, type Span } from "@necrohex/core";
import { buildWad, type LumpInput } from "./build.ts";
import { WadFile, type MapScope } from "./wad.ts";

export type WadExportErrorCode =
  /** 没有任何修改，也没有指定要导出的地图。 */
  | "NOTHING_TO_EXPORT"
  /** 指定的地图名不存在。 */
  | "MAP_NOT_FOUND"
  /** 同名地图不止一张（按名称指定时，或按修改选出的地图重名时），不猜测要哪一张。 */
  | "AMBIGUOUS_MAP"
  /** 有修改落在导出的 Lump 之外，导出会静默丢掉这些修改。 */
  | "CHANGES_OUTSIDE_EXPORT"
  /** 导出地图的某个 Lump 数据不在文件内，无法原样复制。 */
  | "UNREADABLE_LUMP"
  /** 导出结果重新解析后，地图作用域与源文件不一致。 */
  | "VERIFY_FAILED";

/** 导出被拒绝。拒绝时不产生任何输出。 */
export class WadExportError extends Error {
  readonly code: WadExportErrorCode;
  constructor(code: WadExportErrorCode, message: string) {
    super(message);
    this.name = "WadExportError";
    this.code = code;
  }
}

export interface FullWadExport {
  /** 与源文件等长；只有 changed 中的区间与源文件不同。 */
  readonly bytes: Uint8Array;
  /** 自解析以来写入过的区间（合并后）。 */
  readonly changed: readonly Span[];
}

/**
 * 完整 WAD：在源文件字节上覆写脏区间，其余字节（包括目录、间隙和未解析的 Lump）原样保留。
 * 返回新数组，不触碰源文件。写到哪里由调用方决定，调用方不得覆盖源文件。
 */
export function exportFullWad(wad: WadFile): FullWadExport {
  return { bytes: wad.serialize(), changed: wad.dirtySpans() };
}

export interface PwadExportOptions {
  /**
   * 要导出的地图名，大小写不敏感。省略时导出所有含修改的地图。
   * 显式列出的地图即使没有修改也会导出。
   */
  readonly maps?: readonly string[];
}

export interface ExportedMap {
  readonly name: string;
  /** 写入 PWAD 的 Lump 名称，第一个是标记。 */
  readonly lumps: readonly string[];
  /** 该地图是否含修改。 */
  readonly modified: boolean;
}

export interface PwadExport {
  readonly bytes: Uint8Array;
  readonly maps: readonly ExportedMap[];
  /** 导出前后做过的检查，供报告使用。 */
  readonly checks: readonly string[];
}

/**
 * PWAD：每张导出的地图写入标记 Lump 和它作用域内的全部数据 Lump（按源目录顺序，含修改），
 * 不只写改动的 Lump。原始名称字节和未改动的数据逐字节复制。
 * 以下情况拒绝（WadExportError），不产生输出：
 * 有修改落在导出的 Lump 之外、地图名找不到或重名、导出地图的 Lump 数据不可读、导出结果重新解析后作用域不一致。
 */
export function exportPwad(wad: WadFile, options: PwadExportOptions = {}): PwadExport {
  const dirty = wad.dirtySpans();
  const selected = options.maps ? mapsByName(wad, options.maps) : modifiedMaps(wad, dirty);
  if (selected.length === 0) {
    throw new WadExportError("NOTHING_TO_EXPORT", "the WAD has no changes and no maps were requested");
  }
  const names = new Map<string, MapScope>();
  for (const m of selected) {
    const key = m.name.toUpperCase();
    if (names.has(key)) throw new WadExportError("AMBIGUOUS_MAP", `more than one map named ${m.name} would be exported`);
    names.set(key, m);
  }
  selected.sort((a, b) => a.markerIndex - b.markerIndex);

  const included = selected.flatMap((m) => [m.markerIndex, ...m.dataIndices]);
  const covered = mergeSpans(included.flatMap((i) => (wad.lumps[i]!.dataSpan ? [wad.lumps[i]!.dataSpan!] : [])));
  const lost = dirty.filter((d) => !covered.some((c) => spanWithin(d, c)));
  if (lost.length > 0) {
    const where = lost.map((s) => `[${s.start}, ${s.end})`).join(", ");
    throw new WadExportError("CHANGES_OUTSIDE_EXPORT", `changes at ${where} are outside the exported map lumps and would be lost`);
  }

  // 一份当前字节（含修改），所有 Lump 从它切片，避免逐个 Lump 整包拷贝
  const current = wad.serialize();
  const lumps: LumpInput[] = [];
  const exported: ExportedMap[] = [];
  for (const m of selected) {
    const indices = [m.markerIndex, ...m.dataIndices];
    for (const i of indices) {
      const l = wad.lumps[i]!;
      if (l.size !== 0 && !l.dataSpan) {
        throw new WadExportError("UNREADABLE_LUMP", `lump ${i} (${l.name}) of map ${m.name} has data outside the file (${l.issues.join(", ")})`);
      }
      lumps.push({
        name: l.name,
        nameBytes: current.slice(l.nameSpan.start, l.nameSpan.end),
        data: l.dataSpan ? current.slice(l.dataSpan.start, l.dataSpan.end) : new Uint8Array(0),
      });
    }
    exported.push({
      name: m.name,
      lumps: indices.map((i) => wad.lumps[i]!.name),
      modified: indices.some((i) => {
        const s = wad.lumps[i]!.dataSpan;
        return s !== null && dirty.some((d) => spansOverlap(d, s));
      }),
    });
  }

  const bytes = buildWad({ kind: "PWAD", lumps });
  verifyExport(bytes, lumps, selected);
  return {
    bytes,
    maps: exported,
    checks: [
      "every change lies inside an exported lump",
      "each exported map has its marker and every data lump of its scope",
      "the PWAD re-parses with the same map scopes, lump names, raw name bytes and lump data",
    ],
  };
}

function mapsByName(wad: WadFile, requested: readonly string[]): MapScope[] {
  const out: MapScope[] = [];
  for (const name of new Set(requested.map((n) => n.toUpperCase()))) {
    const found = wad.maps.filter((m) => m.name.toUpperCase() === name);
    if (found.length === 0) throw new WadExportError("MAP_NOT_FOUND", `no map named ${name}`);
    if (found.length > 1) throw new WadExportError("AMBIGUOUS_MAP", `${found.length} maps are named ${name}`);
    out.push(found[0]!);
  }
  return out;
}

function modifiedMaps(wad: WadFile, dirty: readonly Span[]): MapScope[] {
  return wad.maps.filter((m) =>
    [m.markerIndex, ...m.dataIndices].some((i) => {
      const s = wad.lumps[i]!.dataSpan;
      return s !== null && dirty.some((d) => spansOverlap(d, s));
    }),
  );
}

/** 重新解析导出结果：Lump 的名称字节和数据逐个相同，每张地图的作用域按同样的名称重新识别。 */
function verifyExport(bytes: Uint8Array, lumps: readonly LumpInput[], selected: readonly MapScope[]): void {
  const fail = (why: string): never => {
    throw new WadExportError("VERIFY_FAILED", `exported PWAD does not round-trip: ${why}`);
  };
  const out = WadFile.parse(bytes);
  if (out.lumps.length !== lumps.length) fail("lump count differs");
  const raw = out.original();
  out.lumps.forEach((l, i) => {
    const want = lumps[i]!;
    if (!equal(raw.subarray(l.nameSpan.start, l.nameSpan.end), want.nameBytes!)) fail(`name bytes of lump ${i} differ`);
    if (!equal(out.lumpBytes(i), want.data)) fail(`data of lump ${i} differs`);
  });
  if (out.maps.length !== selected.length) fail(`expected ${selected.length} maps, found ${out.maps.length}`);
  out.maps.forEach((m, k) => {
    const src = selected[k]!;
    if (m.name !== src.name || m.format !== src.format) fail(`map ${k} is ${m.name} (${m.format}), expected ${src.name} (${src.format})`);
    if (m.dataIndices.length !== src.dataIndices.length) fail(`map ${m.name} has ${m.dataIndices.length} data lumps, expected ${src.dataIndices.length}`);
  });
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
