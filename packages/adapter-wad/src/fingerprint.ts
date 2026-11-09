/**
 * 扇区的语义指纹（docs/design.md 第 7 节），给 pin 重定位用。只读 SECTORS、LINEDEFS、SIDEDEFS、VERTEXES，不写任何东西。
 *
 * 边界线段：任一面的 Sidedef 指向该扇区的 Linedef，两面都指向它时算一条。
 * 几何中心：边界线段的端点按坐标去重后取平均，四舍五入到整数。
 * 边界框：同一组端点的 [minX, minY, maxX, maxY]。
 * 面积：按 Linedef 的方向用鞋带公式求有向面积再取绝对值，四舍五入到整数。正面 Sidedef 在线段右侧，
 * 所以正面属于该扇区时取负的叉积，背面属于该扇区时取正的叉积；两面都属于同一扇区的线段互相抵消，孔洞自动扣除。
 * 边界不闭合时它不是真实面积，但仍是确定的数，可以比较。
 * 没有边界线段的扇区，centroid、bbox、area 都为 null。
 * 下标越界（0xFFFF 或超出记录数）的 Sidedef、扇区和顶点引用按原样跳过，不报错：解析不拒绝历史数据。
 */
import type { FingerprintProblem } from "@necrohex/core";
import { NO_INDEX, type MapScope, type WadFile } from "./wad.ts";

export type BBox = readonly [minX: number, minY: number, maxX: number, maxY: number];

export interface SectorFingerprint {
  readonly tag: number;
  readonly floorpic: string;
  readonly ceilingpic: string;
  /** [floorheight, ceilingheight] */
  readonly heights: readonly [number, number];
  readonly centroid: readonly [number, number] | null;
  /** 边界线段端点的边界框 [minX, minY, maxX, maxY]。 */
  readonly bbox: BBox | null;
  /** 扇区面积（平方地图单位）。 */
  readonly area: number | null;
  readonly lineCount: number;
}

export interface SectorGeometry {
  readonly centroid: readonly [number, number] | null;
  readonly bbox: BBox | null;
  readonly area: number | null;
  readonly lineCount: number;
}

/** 每个扇区的边界线段数、几何中心、边界框和面积，下标即扇区下标。 */
export function sectorGeometry(wad: WadFile, map: MapScope): SectorGeometry[] {
  const sectorsLump = map.lumps["SECTORS"];
  const sectorCount = sectorsLump === undefined ? 0 : wad.recordCount(sectorsLump, "Sector");
  const lines: number[][] = Array.from({ length: sectorCount }, () => []);
  const twiceArea = new Array<number>(sectorCount).fill(0);
  const linesLump = map.lumps["LINEDEFS"];
  const sidesLump = map.lumps["SIDEDEFS"];
  const vertsLump = map.lumps["VERTEXES"];
  const linedefs = linesLump === undefined ? [] : wad.readRecords(linesLump, "Linedef");
  const sidedefs = sidesLump === undefined ? [] : wad.readRecords(sidesLump, "Sidedef");
  const vertexes = vertsLump === undefined ? [] : wad.readRecords(vertsLump, "Vertex");

  linedefs.forEach((l, i) => {
    const owners = new Set<number>();
    const a = l.v1 < vertexes.length ? vertexes[l.v1]! : undefined;
    const b = l.v2 < vertexes.length ? vertexes[l.v2]! : undefined;
    const cross = a && b ? a.x * b.y - b.x * a.y : 0;
    l.sidenum.forEach((side, k) => {
      if (side === NO_INDEX || side >= sidedefs.length) return;
      const sector = sidedefs[side]!.sector;
      if (sector >= sectorCount) return;
      owners.add(sector);
      twiceArea[sector]! += k === 0 ? -cross : cross;
    });
    for (const s of owners) lines[s]!.push(i);
  });

  return lines.map((ids, sector) => {
    const seen = new Set<string>();
    let sx = 0;
    let sy = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const i of ids) {
      const l = linedefs[i]!;
      for (const v of [l.v1, l.v2]) {
        if (v >= vertexes.length) continue;
        const { x, y } = vertexes[v]!;
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sx += x;
        sy += y;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (seen.size === 0) return { centroid: null, bbox: null, area: null, lineCount: ids.length };
    return {
      centroid: [Math.round(sx / seen.size), Math.round(sy / seen.size)],
      bbox: [minX, minY, maxX, maxY],
      area: Math.round(Math.abs(twiceArea[sector]!) / 2),
      lineCount: ids.length,
    };
  });
}

/** 地图里全部扇区的指纹，下标即扇区下标。 */
export function sectorFingerprints(wad: WadFile, map: MapScope, geometry: readonly SectorGeometry[] = sectorGeometry(wad, map)): SectorFingerprint[] {
  const lump = map.lumps["SECTORS"];
  if (lump === undefined) return [];
  return wad.readRecords(lump, "Sector").map((s, i) => ({
    tag: s.tag,
    floorpic: s.floorpic,
    ceilingpic: s.ceilingpic,
    heights: [s.floorheight, s.ceilingheight] as const,
    centroid: geometry[i]!.centroid,
    bbox: geometry[i]!.bbox,
    area: geometry[i]!.area,
    lineCount: geometry[i]!.lineCount,
  }));
}

const KEYS = ["tag", "floorpic", "ceilingpic", "heights", "centroid", "bbox", "area", "lineCount"] as const;

const isInt16 = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= -32768 && v <= 32767;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 补丁里的扇区指纹必须恰好有这八个键。 */
export function validateSectorFingerprint(v: unknown): FingerprintProblem[] {
  const out: FingerprintProblem[] = [];
  const bad = (path: string, message: string) => out.push({ path, message });
  if (!isPlainObject(v)) {
    bad("", `a Sector fingerprint must be an object with ${KEYS.join(", ")}`);
    return out;
  }
  for (const k of Object.keys(v)) if (!(KEYS as readonly string[]).includes(k)) bad(`/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, `unknown key ${JSON.stringify(k)}`);
  for (const k of KEYS) if (!Object.hasOwn(v, k)) bad(`/${k}`, `${k} is required`);
  if (Object.hasOwn(v, "tag") && !isInt16(v.tag)) bad("/tag", "tag must be an int16 integer");
  for (const k of ["floorpic", "ceilingpic"] as const) {
    if (Object.hasOwn(v, k) && !(typeof v[k] === "string" && (v[k] as string).length <= 8)) bad(`/${k}`, `${k} must be a string of at most 8 characters`);
  }
  if (Object.hasOwn(v, "heights") && !(Array.isArray(v.heights) && v.heights.length === 2 && v.heights.every(isInt16))) {
    bad("/heights", "heights must be [floorheight, ceilingheight] with two int16 integers");
  }
  if (Object.hasOwn(v, "centroid") && v.centroid !== null && !(Array.isArray(v.centroid) && v.centroid.length === 2 && v.centroid.every((x) => typeof x === "number" && Number.isFinite(x)))) {
    bad("/centroid", "centroid must be [x, y] with two finite numbers, or null");
  }
  if (Object.hasOwn(v, "bbox") && v.bbox !== null) {
    const b = v.bbox;
    if (!(Array.isArray(b) && b.length === 4 && b.every(isInt16))) bad("/bbox", "bbox must be [minX, minY, maxX, maxY] with four int16 integers, or null");
    else if ((b[0] as number) > (b[2] as number) || (b[1] as number) > (b[3] as number)) bad("/bbox", "bbox must have minX <= maxX and minY <= maxY");
  }
  if (Object.hasOwn(v, "area") && v.area !== null && !(typeof v.area === "number" && Number.isSafeInteger(v.area) && v.area >= 0)) {
    bad("/area", "area must be a non-negative integer, or null");
  }
  // 三个几何量来自同一组边界线段：要么都有，要么都为 null（没有边界线段的扇区）
  const geo = (["centroid", "bbox", "area"] as const).filter((k) => Object.hasOwn(v, k));
  if (geo.length === 3 && new Set(geo.map((k) => v[k] === null)).size > 1) {
    bad("", "centroid, bbox and area must all be null (a sector without boundary lines) or all be set");
  }
  if (Object.hasOwn(v, "lineCount") && !(typeof v.lineCount === "number" && Number.isSafeInteger(v.lineCount) && v.lineCount >= 0)) {
    bad("/lineCount", "lineCount must be a non-negative integer");
  }
  return out;
}

/** 只把 ASCII a–z 转大写。原版引擎查找 Flat 名时不区分大小写。 */
function asciiUpper(s: string): string {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}

export type FingerprintPart = "centroid" | "bbox" | "area" | "lineCount" | "heights" | "floorpic" | "ceilingpic" | "tag";

export interface FingerprintParams {
  /** 各组成部分的权重，合计为 1。 */
  readonly weights: Readonly<Record<FingerprintPart, number>>;
  /** 几何中心相距这么多地图单位及以上得 0，线性衰减。 */
  readonly centroidRadius: number;
  /** 边界框：每个轴上 (重叠长度 + bboxSlack) / (并集长度 + bboxSlack)，两轴相乘。 */
  readonly bboxSlack: number;
  /** 面积：(较小面积 + areaSlack) / (较大面积 + areaSlack)。 */
  readonly areaSlack: number;
}

/**
 * 默认参数。几何（中心、边界框、面积）合计 0.7：属性完全相同、几何完全不同的扇区最多得 0.3。
 * 边界框按重叠比例而不是绝对偏移打分：同心但大小不同的扇区、平移了自身宽度的窄扇区都得低分，大扇区改动几个单位影响很小。
 * 面积区分边界框相同、形状不同的扇区（例如同一区域被重新拆分）。
 * 用 Freedoom 0.12.1 与 0.13.0 校准，用 0.11.3 做留出验证，过程见 docs/decisions.md。
 */
export const FINGERPRINT_PARAMS: FingerprintParams = Object.freeze({
  weights: Object.freeze({ centroid: 0.2, bbox: 0.3, area: 0.2, heights: 0.1, lineCount: 0.05, floorpic: 0.05, ceilingpic: 0.05, tag: 0.05 }),
  centroidRadius: 32,
  bboxSlack: 8,
  areaSlack: 64,
});

/** 两个可能为 null 的几何量：都为 null 得 1，只有一个为 null 得 0，否则用 f 比较。 */
function both<T>(a: T | null, b: T | null, f: (a: T, b: T) => number): number {
  if (a === null || b === null) return a === b ? 1 : 0;
  return f(a, b);
}

/** 边界框的相似度：每个轴上 (重叠 + slack) / (并集 + slack)，两轴相乘，取值 (0, 1]。 */
export function bboxOverlap(a: BBox, b: BBox, slack: number): number {
  let r = 1;
  for (const k of [0, 1] as const) {
    const overlap = Math.max(0, Math.min(a[k + 2]!, b[k + 2]!) - Math.max(a[k]!, b[k]!));
    const union = Math.max(a[k + 2]!, b[k + 2]!) - Math.min(a[k]!, b[k]!);
    r *= (overlap + slack) / (union + slack);
  }
  return r;
}

/** 各组成部分的相似度，每项取值 [0, 1]。 */
export function sectorFingerprintParts(expected: SectorFingerprint, actual: SectorFingerprint, p: FingerprintParams = FINGERPRINT_PARAMS): Record<FingerprintPart, number> {
  const lineMax = Math.max(expected.lineCount, actual.lineCount);
  return {
    centroid: both(expected.centroid, actual.centroid, (a, b) => Math.max(0, 1 - Math.hypot(a[0] - b[0], a[1] - b[1]) / p.centroidRadius)),
    bbox: both(expected.bbox, actual.bbox, (a, b) => bboxOverlap(a, b, p.bboxSlack)),
    area: both(expected.area, actual.area, (a, b) => (Math.min(a, b) + p.areaSlack) / (Math.max(a, b) + p.areaSlack)),
    lineCount: lineMax === 0 ? 1 : 1 - Math.abs(expected.lineCount - actual.lineCount) / lineMax,
    heights: ((expected.heights[0] === actual.heights[0] ? 1 : 0) + (expected.heights[1] === actual.heights[1] ? 1 : 0)) / 2,
    floorpic: asciiUpper(expected.floorpic) === asciiUpper(actual.floorpic) ? 1 : 0,
    ceilingpic: asciiUpper(expected.ceilingpic) === asciiUpper(actual.ceilingpic) ? 1 : 0,
    tag: expected.tag === actual.tag ? 1 : 0,
  };
}

/** 按权重合计各组成部分。 */
export function weightedScore(parts: Readonly<Record<FingerprintPart, number>>, weights: Readonly<Record<FingerprintPart, number>>): number {
  let s = 0;
  for (const k of Object.keys(weights) as FingerprintPart[]) s += weights[k] * parts[k];
  return s;
}

/** expected 与 actual 的相似度，取值 [0, 1]，完全一致为 1。 */
export function sectorFingerprintScore(expected: SectorFingerprint, actual: SectorFingerprint, p: FingerprintParams = FINGERPRINT_PARAMS): number {
  return weightedScore(sectorFingerprintParts(expected, actual, p), p.weights);
}
