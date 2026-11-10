/**
 * 扇区轮廓，给工作台画地图用。只读 LINEDEFS、SIDEDEFS、VERTEXES，不写任何东西。
 *
 * 每条 Linedef：正面 Sidedef 所在的扇区得到有向边 v1→v2，背面所在的扇区得到 v2→v1。
 * 两面属于同一扇区的线段是扇区内部的线，不产生边。
 * 每个扇区从未用过的边出发，沿起点坐标相同的边走，回到出发点时得到一个闭合环；走不下去时得到一条不闭合的链，也作为一个环返回。
 * 按 even-odd 规则填充这些环，扇区里的孔洞（另一个扇区）自然被扣除。
 * 下标越界（0xFFFF 或超出记录数）的 Sidedef、扇区和顶点引用按原样跳过，不报错：解析不拒绝历史数据。
 */
import { NO_INDEX, type MapScope, type WadFile } from "./wad.ts";

export type OutlinePoint = readonly [x: number, y: number];

export interface SectorOutline {
  /** 环，地图坐标。 */
  readonly loops: readonly (readonly OutlinePoint[])[];
  /** 环中有几个没有闭合。 */
  readonly openLoops: number;
}

interface Edge {
  readonly from: OutlinePoint;
  readonly to: OutlinePoint;
  used: boolean;
}

const key = (p: OutlinePoint) => `${p[0]},${p[1]}`;

/** 地图里每个扇区的轮廓，下标即扇区下标。 */
export function sectorOutlines(wad: WadFile, map: MapScope): SectorOutline[] {
  const sectorsLump = map.lumps["SECTORS"];
  const sectorCount = sectorsLump === undefined ? 0 : wad.recordCount(sectorsLump, "Sector");
  const linesLump = map.lumps["LINEDEFS"];
  const sidesLump = map.lumps["SIDEDEFS"];
  const vertsLump = map.lumps["VERTEXES"];
  const linedefs = linesLump === undefined ? [] : wad.readRecords(linesLump, "Linedef");
  const sidedefs = sidesLump === undefined ? [] : wad.readRecords(sidesLump, "Sidedef");
  const vertexes = vertsLump === undefined ? [] : wad.readRecords(vertsLump, "Vertex");

  const edges: Edge[][] = Array.from({ length: sectorCount }, () => []);
  const sectorOf = (side: number | undefined): number | undefined => {
    if (side === undefined || side === NO_INDEX || side >= sidedefs.length) return undefined;
    const s = sidedefs[side]!.sector;
    return s < sectorCount ? s : undefined;
  };
  for (const l of linedefs) {
    if (l.v1 >= vertexes.length || l.v2 >= vertexes.length) continue;
    const a: OutlinePoint = [vertexes[l.v1]!.x, vertexes[l.v1]!.y];
    const b: OutlinePoint = [vertexes[l.v2]!.x, vertexes[l.v2]!.y];
    const front = sectorOf(l.sidenum[0]);
    const back = sectorOf(l.sidenum[1]);
    if (front !== undefined && front === back) continue;
    if (front !== undefined) edges[front]!.push({ from: a, to: b, used: false });
    if (back !== undefined) edges[back]!.push({ from: b, to: a, used: false });
  }

  return edges.map((list) => {
    const byStart = new Map<string, Edge[]>();
    for (const e of list) {
      const k = key(e.from);
      const at = byStart.get(k);
      if (at) at.push(e);
      else byStart.set(k, [e]);
    }
    const next = (p: OutlinePoint): Edge | undefined => byStart.get(key(p))?.find((e) => !e.used);
    const loops: OutlinePoint[][] = [];
    let openLoops = 0;
    for (const first of list) {
      if (first.used) continue;
      first.used = true;
      const start = key(first.from);
      const loop: OutlinePoint[] = [first.from];
      let cur = first.to;
      let closed = false;
      for (;;) {
        if (key(cur) === start) {
          closed = true;
          break;
        }
        loop.push(cur);
        const e = next(cur);
        if (!e) break;
        e.used = true;
        cur = e.to;
      }
      if (!closed) openLoops++;
      loops.push(loop);
    }
    return { loops, openLoops };
  });
}
