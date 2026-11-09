/**
 * 重定位的两个独立对照，都不使用 src/fingerprint.ts 的任何代码，供 relocation-report.ts 和 calibrate-relocation.ts 使用。
 *
 * 对照一：边界线段坐标完全相同（geometryKeys、uniqueIndex）。扇区全部边界线段按坐标（无向）排序后的列表，
 * 在两个版本里各自唯一且相同，就认为是同一个扇区。只能核对没有改过几何的扇区。
 *
 * 对照二：面积覆盖（mapArea、coverage）。
 *
 * 扇区的边界线段是任一面 Sidedef 指向它的 Linedef，但两面都指向同一扇区的线段不算（这类线段在扇区内部，不分隔内外）。
 * 点是否在扇区内按奇偶规则判断：从点向 +x 方向作射线，与该扇区边界线段的交点数为奇数即在内部。
 * 在源扇区的边界框内按网格取点，只保留落在源扇区内的点；再看这些点落在目标版本哪些扇区里。
 * 网格点带一个非整数偏移，不会正好落在整数坐标的顶点或水平线段上。
 *
 * 这是启发式：环形扇区、自相交或重叠的线段、未闭合的边界都可能让奇偶规则给出错误的内外；
 * 扇区在版本之间被拆分或合并时，覆盖率低不代表选错。报告里要按这一点解读。
 */
import { NO_INDEX, type MapScope, type WadFile } from "../src/index.ts";

interface Seg {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** 这条线段计入哪些扇区的边界（一个或两个） */
  readonly owners: readonly number[];
}

export interface MapArea {
  readonly sectorCount: number;
  /** 每个扇区在源网格上落在扇区内的采样点 */
  readonly samples: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  /** 返回包含该点的全部扇区（按奇偶规则） */
  sectorsAt(x: number, y: number): number[];
}

const ROW = 64;
const OFFSET_X = 0.3711;
const OFFSET_Y = 0.6173;

export function mapArea(wad: WadFile, map: MapScope): MapArea {
  const secLump = map.lumps["SECTORS"];
  const n = secLump === undefined ? 0 : wad.recordCount(secLump, "Sector");
  const ls = map.lumps["LINEDEFS"] === undefined ? [] : wad.readRecords(map.lumps["LINEDEFS"], "Linedef");
  const ss = map.lumps["SIDEDEFS"] === undefined ? [] : wad.readRecords(map.lumps["SIDEDEFS"], "Sidedef");
  const vs = map.lumps["VERTEXES"] === undefined ? [] : wad.readRecords(map.lumps["VERTEXES"], "Vertex");
  const segs: Seg[] = [];
  const bySector: Seg[][] = Array.from({ length: n }, () => []);
  for (const l of ls) {
    const sides = l.sidenum.filter((s) => s !== NO_INDEX && s < ss.length).map((s) => ss[s]!.sector).filter((s) => s < n);
    const owners = [...new Set(sides)];
    // 两面都属于同一扇区：不是内外分界
    if (sides.length === 2 && owners.length === 1) continue;
    const a = vs[l.v1];
    const b = vs[l.v2];
    if (!a || !b || owners.length === 0) continue;
    const seg = { x1: a.x, y1: a.y, x2: b.x, y2: b.y, owners };
    segs.push(seg);
    for (const o of owners) bySector[o]!.push(seg);
  }

  // 按 y 分行索引线段，射线只需要检查所在行的线段
  const rows = new Map<number, Seg[]>();
  for (const s of segs) {
    const lo = Math.floor(Math.min(s.y1, s.y2) / ROW);
    const hi = Math.floor(Math.max(s.y1, s.y2) / ROW);
    for (let r = lo; r <= hi; r++) {
      let row = rows.get(r);
      if (!row) rows.set(r, (row = []));
      row.push(s);
    }
  }
  const crosses = (s: Seg, x: number, y: number): boolean => {
    if (s.y1 > y === s.y2 > y) return false;
    const xi = s.x1 + ((y - s.y1) * (s.x2 - s.x1)) / (s.y2 - s.y1);
    return xi > x;
  };
  const sectorsAt = (x: number, y: number): number[] => {
    const parity = new Map<number, number>();
    for (const s of rows.get(Math.floor(y / ROW)) ?? []) {
      if (!crosses(s, x, y)) continue;
      for (const o of s.owners) parity.set(o, (parity.get(o) ?? 0) ^ 1);
    }
    return [...parity].filter(([, p]) => p === 1).map(([o]) => o).sort((a, b) => a - b);
  };
  const inside = (sector: number, x: number, y: number): boolean => {
    let p = 0;
    for (const s of bySector[sector]!) if (crosses(s, x, y)) p ^= 1;
    return p === 1;
  };

  const samples = bySector.map((own, sector) => {
    if (own.length === 0) return [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of own) {
      minX = Math.min(minX, s.x1, s.x2);
      maxX = Math.max(maxX, s.x1, s.x2);
      minY = Math.min(minY, s.y1, s.y2);
      maxY = Math.max(maxY, s.y1, s.y2);
    }
    for (const k of [16, 48]) {
      const pts: Array<[number, number]> = [];
      const sx = (maxX - minX) / k;
      const sy = (maxY - minY) / k;
      if (sx === 0 || sy === 0) return [];
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) {
          const x = minX + (i + 0.5) * sx + OFFSET_X * Math.min(1, sx / 2);
          const y = minY + (j + 0.5) * sy + OFFSET_Y * Math.min(1, sy / 2);
          if (inside(sector, x, y)) pts.push([x, y]);
        }
      }
      if (pts.length >= 16 || k === 48) return pts;
    }
    return [];
  });
  return { sectorCount: n, samples, sectorsAt };
}

export interface Coverage {
  /** 源扇区的采样点数；0 表示无法判断 */
  readonly samples: number;
  /** 采样点落在被选中扇区内的比例 */
  readonly chosen: number;
  /** 覆盖率最高的目标扇区及其覆盖率；没有采样点落在任何扇区内时为 undefined */
  readonly best: { readonly index: number; readonly coverage: number } | undefined;
}

/** 源扇区 from 的采样点落在目标地图各扇区内的比例。 */
export function coverage(src: MapArea, dst: MapArea, from: number, chosen: number | undefined): Coverage {
  const pts = src.samples[from] ?? [];
  if (pts.length === 0) return { samples: 0, chosen: 0, best: undefined };
  const hits = new Map<number, number>();
  for (const [x, y] of pts) for (const s of dst.sectorsAt(x, y)) hits.set(s, (hits.get(s) ?? 0) + 1);
  let best: { index: number; coverage: number } | undefined;
  for (const [index, h] of hits) {
    const c = h / pts.length;
    if (!best || c > best.coverage || (c === best.coverage && index < best.index)) best = { index, coverage: c };
  }
  return { samples: pts.length, chosen: chosen === undefined ? 0 : (hits.get(chosen) ?? 0) / pts.length, best };
}

/** 对照一：每个扇区的边界线段坐标列表（无向、排序后拼接），下标即扇区下标。没有边界线段为空串。 */
export function geometryKeys(wad: WadFile, map: MapScope): string[] {
  const secLump = map.lumps["SECTORS"];
  const n = secLump === undefined ? 0 : wad.recordCount(secLump, "Sector");
  const ls = map.lumps["LINEDEFS"] === undefined ? [] : wad.readRecords(map.lumps["LINEDEFS"], "Linedef");
  const ss = map.lumps["SIDEDEFS"] === undefined ? [] : wad.readRecords(map.lumps["SIDEDEFS"], "Sidedef");
  const vs = map.lumps["VERTEXES"] === undefined ? [] : wad.readRecords(map.lumps["VERTEXES"], "Vertex");
  const segs: string[][] = Array.from({ length: n }, () => []);
  for (const l of ls) {
    const owners = new Set<number>();
    for (const s of l.sidenum) if (s !== NO_INDEX && s < ss.length && ss[s]!.sector < n) owners.add(ss[s]!.sector);
    const a = vs[l.v1];
    const b = vs[l.v2];
    if (!a || !b) continue;
    const p = `${a.x},${a.y}`;
    const q = `${b.x},${b.y}`;
    const seg = p < q ? `${p}-${q}` : `${q}-${p}`;
    for (const s of owners) segs[s]!.push(seg);
  }
  return segs.map((s) => s.sort().join("|"));
}

/** 只出现一次的非空键 → 下标。 */
export function uniqueIndex(keys: readonly string[]): Map<string, number> {
  const seen = new Map<string, number>();
  keys.forEach((k) => seen.set(k, (seen.get(k) ?? 0) + 1));
  const out = new Map<string, number>();
  keys.forEach((k, i) => {
    if (k !== "" && seen.get(k) === 1) out.set(k, i);
  });
  return out;
}

/** 对照一给出的目标：源扇区 i 的键在源和目标版本里都唯一时，目标版本里的下标；否则 undefined。 */
export function geometryTruth(srcKeys: readonly string[], dstKeys: readonly string[]): Array<number | undefined> {
  const ua = uniqueIndex(srcKeys);
  const ub = uniqueIndex(dstKeys);
  return srcKeys.map((k, i) => (ua.get(k) === i ? ub.get(k) : undefined));
}
