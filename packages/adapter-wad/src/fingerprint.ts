/**
 * 扇区的语义指纹（docs/design.md 第 7 节），给 pin 重定位用。只读 SECTORS、LINEDEFS、SIDEDEFS、VERTEXES，不写任何东西。
 *
 * 边界线段：任一面的 Sidedef 指向该扇区的 Linedef，两面都指向它时算一条。
 * 几何中心：边界线段的端点按坐标去重后取平均，四舍五入到整数。扇区可能不连通或带孔，这里不求多边形。
 * 没有边界线段的扇区，centroid 为 null。
 * 下标越界（0xFFFF 或超出记录数）的 Sidedef、扇区和顶点引用按原样跳过，不报错：解析不拒绝历史数据。
 */
import type { FingerprintProblem } from "@necrohex/core";
import { NO_INDEX, type MapScope, type WadFile } from "./wad.ts";

export interface SectorFingerprint {
  readonly tag: number;
  readonly floorpic: string;
  readonly ceilingpic: string;
  /** [floorheight, ceilingheight] */
  readonly heights: readonly [number, number];
  readonly centroid: readonly [number, number] | null;
  readonly lineCount: number;
}

export interface SectorGeometry {
  readonly centroid: readonly [number, number] | null;
  readonly lineCount: number;
}

/** 每个扇区的边界线段数和几何中心，下标即扇区下标。 */
export function sectorGeometry(wad: WadFile, map: MapScope): SectorGeometry[] {
  const sectorsLump = map.lumps["SECTORS"];
  const sectorCount = sectorsLump === undefined ? 0 : wad.recordCount(sectorsLump, "Sector");
  const lines: number[][] = Array.from({ length: sectorCount }, () => []);
  const linesLump = map.lumps["LINEDEFS"];
  const sidesLump = map.lumps["SIDEDEFS"];
  const vertsLump = map.lumps["VERTEXES"];
  const linedefs = linesLump === undefined ? [] : wad.readRecords(linesLump, "Linedef");
  const sidedefs = sidesLump === undefined ? [] : wad.readRecords(sidesLump, "Sidedef");
  const vertexes = vertsLump === undefined ? [] : wad.readRecords(vertsLump, "Vertex");

  linedefs.forEach((l, i) => {
    const owners = new Set<number>();
    for (const side of l.sidenum) {
      if (side === NO_INDEX || side >= sidedefs.length) continue;
      const sector = sidedefs[side]!.sector;
      if (sector < sectorCount) owners.add(sector);
    }
    for (const s of owners) lines[s]!.push(i);
  });

  return lines.map((ids) => {
    const seen = new Set<string>();
    let sx = 0;
    let sy = 0;
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
      }
    }
    const centroid: readonly [number, number] | null = seen.size === 0 ? null : [Math.round(sx / seen.size), Math.round(sy / seen.size)];
    return { centroid, lineCount: ids.length };
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
    lineCount: geometry[i]!.lineCount,
  }));
}

const KEYS = ["tag", "floorpic", "ceilingpic", "heights", "centroid", "lineCount"] as const;

const isInt16 = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= -32768 && v <= 32767;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 补丁里的扇区指纹必须恰好有这六个键。 */
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
  if (Object.hasOwn(v, "lineCount") && !(typeof v.lineCount === "number" && Number.isSafeInteger(v.lineCount) && v.lineCount >= 0)) {
    bad("/lineCount", "lineCount must be a non-negative integer");
  }
  return out;
}

/** 只把 ASCII a–z 转大写。原版引擎查找 Flat 名时不区分大小写。 */
function asciiUpper(s: string): string {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}

/**
 * 相似度的组成和权重，合计为 1。几何中心权重最大：只有它区分位置不同、属性相同的扇区。
 * 几何中心按距离线性衰减，相距 CENTROID_RADIUS 个地图单位及以上得 0。
 * 32 是用 Freedoom 0.12.1 与 0.13.0 的 32 张地图校准的结果，16、64、128 的对比见 docs/decisions.md。
 */
export const FINGERPRINT_WEIGHTS = Object.freeze({ centroid: 0.4, lineCount: 0.1, heights: 0.2, floorpic: 0.1, ceilingpic: 0.1, tag: 0.1 });
export const CENTROID_RADIUS = 32;

/** expected 与 actual 的相似度，取值 [0, 1]，完全一致为 1。 */
export function sectorFingerprintScore(expected: SectorFingerprint, actual: SectorFingerprint): number {
  const w = FINGERPRINT_WEIGHTS;
  let centroid: number;
  if (expected.centroid === null || actual.centroid === null) centroid = expected.centroid === actual.centroid ? 1 : 0;
  else {
    const d = Math.hypot(expected.centroid[0] - actual.centroid[0], expected.centroid[1] - actual.centroid[1]);
    centroid = Math.max(0, 1 - d / CENTROID_RADIUS);
  }
  const lineMax = Math.max(expected.lineCount, actual.lineCount);
  const lineCount = lineMax === 0 ? 1 : 1 - Math.abs(expected.lineCount - actual.lineCount) / lineMax;
  const heights = ((expected.heights[0] === actual.heights[0] ? 1 : 0) + (expected.heights[1] === actual.heights[1] ? 1 : 0)) / 2;
  return (
    w.centroid * centroid +
    w.lineCount * lineCount +
    w.heights * heights +
    w.floorpic * (asciiUpper(expected.floorpic) === asciiUpper(actual.floorpic) ? 1 : 0) +
    w.ceilingpic * (asciiUpper(expected.ceilingpic) === asciiUpper(actual.ceilingpic) ? 1 : 0) +
    w.tag * (expected.tag === actual.tag ? 1 : 0)
  );
}
