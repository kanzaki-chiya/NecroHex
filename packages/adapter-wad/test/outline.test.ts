import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sectorGeometry } from "../src/fingerprint.ts";
import { buildWad, MAP_DATA_LUMPS, NO_INDEX, sectorOutlines, WadFile } from "../src/index.ts";

const FIXTURE = new Uint8Array(readFileSync(resolve(import.meta.dirname, "../fixtures/freedoom/freedoom2-map01-02.wad")));

/** 环的有向面积（鞋带公式）的绝对值。 */
function area(loop: readonly (readonly [number, number])[]): number {
  let s = 0;
  loop.forEach(([x1, y1], i) => {
    const [x2, y2] = loop[(i + 1) % loop.length]!;
    s += x1 * y2 - x2 * y1;
  });
  return Math.abs(s) / 2;
}

describe("sectorOutlines", () => {
  it("Freedoom MAP01、MAP02：每个扇区都有环，全部闭合；只有一个环的扇区面积等于指纹面积", () => {
    const wad = WadFile.parse(FIXTURE);
    for (const name of ["MAP01", "MAP02"]) {
      const map = wad.findMap(name)!;
      const outlines = sectorOutlines(wad, map);
      const geo = sectorGeometry(wad, map);
      expect(outlines.length).toBe(wad.recordCount(map.lumps["SECTORS"]!, "Sector"));
      let single = 0;
      outlines.forEach((o, i) => {
        expect(o.loops.length, `${name} #${i}`).toBeGreaterThan(0);
        expect(o.openLoops, `${name} #${i}`).toBe(0);
        if (o.loops.length === 1) {
          single++;
          expect(Math.round(area(o.loops[0]!)), `${name} #${i}`).toBe(geo[i]!.area);
        }
      });
      expect(single).toBeGreaterThan(outlines.length / 2);
    }
  });

  it("两面属于同一扇区的线不产生边；越界的 Sidedef 跳过", () => {
    const vert = (x: number, y: number) => [x & 0xff, (x >> 8) & 0xff, y & 0xff, (y >> 8) & 0xff];
    const vertexes = new Uint8Array([...vert(0, 0), ...vert(64, 0), ...vert(64, 64), ...vert(0, 64)]);
    const line = (v1: number, v2: number, front: number, back: number) => {
      const b = new Uint8Array(14);
      const v = new DataView(b.buffer);
      v.setUint16(0, v1, true);
      v.setUint16(2, v2, true);
      v.setUint16(10, front, true);
      v.setUint16(12, back, true);
      return [...b];
    };
    // 正方形四条边，外加一条对角线：两面都是扇区 0
    const linedefs = new Uint8Array([...line(0, 1, 0, NO_INDEX), ...line(1, 2, 0, NO_INDEX), ...line(2, 3, 0, 9), ...line(3, 0, 0, NO_INDEX), ...line(0, 2, 0, 0)]);
    const sidedefs = new Uint8Array(30); // sector 0
    const data: Record<string, Uint8Array> = { VERTEXES: vertexes, LINEDEFS: linedefs, SIDEDEFS: sidedefs, SECTORS: new Uint8Array(26) };
    const bytes = buildWad({ kind: "PWAD", lumps: [{ name: "MAP01", data: new Uint8Array(0) }, ...MAP_DATA_LUMPS.map((name) => ({ name, data: data[name] ?? new Uint8Array(0) }))] });
    const wad = WadFile.parse(bytes);
    const [o] = sectorOutlines(wad, wad.findMap("MAP01")!);
    expect(o!.loops).toEqual([[[0, 0], [64, 0], [64, 64], [0, 64]]]);
    expect(o!.openLoops).toBe(0);
  });
});
