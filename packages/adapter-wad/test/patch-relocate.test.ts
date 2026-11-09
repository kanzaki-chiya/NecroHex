/**
 * I-5 重定位（docs/design.md 第 7、10 节）：对扇区做重排后，pin 解析出的目标等于重排后的原目标。
 * 重排同时改写 SECTORS 的记录顺序和 SIDEDEFS 的 sector 下标，地图的几何和扇区属性不变，所以指纹的相似度只是换了下标。
 * 两类样本：带矩形房间几何的生成地图（含完全相同和几乎相同的扇区，用来触发歧义），以及 Freedoom 夹具。
 */
import { applyPatch, planPatch, revertPatch, type PinResolution } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildWad, MAP_DATA_LUMPS, NO_INDEX, wadAdapter, WadFile, type LumpInput } from "../src/index.ts";
import { FIXTURE, Hits, RUNS, sameBytes } from "./patch-helpers.ts";

interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  floor: string;
  ceil: string;
  fh: number;
  ch: number;
  tag: number;
}

const room: fc.Arbitrary<Room> = fc.record({
  x: fc.integer({ min: -256, max: 256 }).map((v) => v * 8),
  y: fc.integer({ min: -256, max: 256 }).map((v) => v * 8),
  w: fc.integer({ min: 2, max: 64 }).map((v) => v * 8),
  h: fc.integer({ min: 2, max: 64 }).map((v) => v * 8),
  floor: fc.constantFrom("FLAT1", "FLOOR4_8", "NUKAGE1"),
  ceil: fc.constantFrom("FLAT1", "CEIL3_5"),
  fh: fc.constantFrom(0, 8, 16),
  ch: fc.constantFrom(128, 136),
  tag: fc.constantFrom(0, 0, 1, 2),
});

function name8(view: DataView, at: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
}

/**
 * 一张 MAP01：每个房间是一个矩形扇区，4 个顶点、4 条单面线段（背面为 0xFFFF）。
 * twins 复制已有房间（指纹完全相同），nearby 复制后平移几个单位（指纹几乎相同）；garbage 加入越界的 Sidedef、扇区和顶点引用。
 */
export const roomsWad: fc.Arbitrary<Uint8Array> = fc
  .record({
    rooms: fc.array(room, { minLength: 1, maxLength: 10 }),
    twins: fc.array(fc.nat(), { maxLength: 2 }),
    nearby: fc.array(fc.record({ from: fc.nat(), dx: fc.integer({ min: -8, max: 8 }) }), { maxLength: 2 }),
    garbage: fc.boolean(),
    rotate: fc.nat(),
  })
  .map(({ rooms, twins, nearby, garbage, rotate }) => {
    const all = [...rooms];
    for (const t of twins) all.push({ ...all[t % all.length]! });
    for (const n of nearby) {
      const r = all[n.from % all.length]!;
      all.push({ ...r, x: r.x + n.dx });
    }
    const verts: Array<[number, number]> = [];
    const lines: Array<[number, number, number, number]> = []; // v1, v2, front, back
    const sides: number[] = []; // sector
    all.forEach((r, s) => {
      const base = verts.length;
      verts.push([r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]);
      for (let k = 0; k < 4; k++) {
        sides.push(s);
        lines.push([base + k, base + ((k + 1) % 4), sides.length - 1, NO_INDEX]);
      }
    });
    if (garbage) {
      sides.push(0xfff0); // 指向不存在的扇区
      lines.push([0, 1, sides.length - 1, NO_INDEX]);
      lines.push([0, 1, 0xfff0, NO_INDEX]); // 指向不存在的 Sidedef
      lines.push([0xfff0, 0, 0, NO_INDEX]); // 指向不存在的顶点
    }
    const order = lines.map((_, i) => lines[(i + rotate) % lines.length]!);

    const sec = new Uint8Array(26 * all.length);
    const sv = new DataView(sec.buffer);
    all.forEach((r, i) => {
      sv.setInt16(i * 26, r.fh, true);
      sv.setInt16(i * 26 + 2, r.ch, true);
      name8(sv, i * 26 + 4, r.floor);
      name8(sv, i * 26 + 12, r.ceil);
      sv.setInt16(i * 26 + 20, 160, true);
      sv.setInt16(i * 26 + 24, r.tag, true);
    });
    const ln = new Uint8Array(14 * order.length);
    const lv = new DataView(ln.buffer);
    order.forEach(([a, b, f, k], i) => {
      lv.setUint16(i * 14, a, true);
      lv.setUint16(i * 14 + 2, b, true);
      lv.setUint16(i * 14 + 10, f, true);
      lv.setUint16(i * 14 + 12, k, true);
    });
    const sd = new Uint8Array(30 * sides.length);
    const dv = new DataView(sd.buffer);
    sides.forEach((s, i) => dv.setUint16(i * 30 + 28, s, true));
    const vx = new Uint8Array(4 * verts.length);
    const vv = new DataView(vx.buffer);
    verts.forEach(([x, y], i) => {
      vv.setInt16(i * 4, x, true);
      vv.setInt16(i * 4 + 2, y, true);
    });
    const data: Record<string, Uint8Array> = { THINGS: new Uint8Array(10), LINEDEFS: ln, SIDEDEFS: sd, VERTEXES: vx, SECTORS: sec };
    const lumps: LumpInput[] = [{ name: "MAP01", data: new Uint8Array(0) }, ...MAP_DATA_LUMPS.map((n) => ({ name: n, data: data[n] ?? new Uint8Array(4) }))];
    return buildWad({ kind: "PWAD", lumps });
  });

/**
 * 重排 map 的扇区：原 #i 移到 #perm[i]，Sidedef 里指向 #i 的下标改成 perm[i]，越界的下标不变。
 * 其他 Lump 的名称字节和数据原样复制（REJECT 等按扇区编号的 Lump 因此不再对应，引擎不读它们）。
 */
export function permuteSectors(bytes: Uint8Array, mapName: string, perm: readonly number[]): Uint8Array {
  const wad = WadFile.parse(bytes);
  const m = wad.findMap(mapName)!;
  const secLump = m.lumps["SECTORS"]!;
  const sideLump = m.lumps["SIDEDEFS"]!;
  const n = perm.length;
  const original = wad.original();
  const lumps: LumpInput[] = wad.lumps.map((l) => {
    let data = l.dataSpan ? original.slice(l.dataSpan.start, l.dataSpan.end) : new Uint8Array(0);
    if (l.index === secLump) {
      const out = data.slice();
      for (let i = 0; i < n; i++) out.set(data.subarray(i * 26, i * 26 + 26), perm[i]! * 26);
      data = out;
    } else if (l.index === sideLump) {
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let at = 28; at + 2 <= data.length; at += 30) {
        const s = v.getUint16(at, true);
        if (s < n) v.setUint16(at, perm[s]!, true);
      }
    }
    return { name: l.name, nameBytes: original.slice(l.nameSpan.start, l.nameSpan.end), data };
  });
  return buildWad({ kind: wad.kind, lumps });
}

const pinPatch = (map: string, expectedIndex: number, fingerprint: unknown) => ({
  schemaVersion: 1,
  name: "relocate",
  target: { format: "wad", maps: [map] },
  operations: [{ id: "p", select: { record: "Sector", pin: { map, expectedIndex, fingerprint } }, change: { lightlevel: { set: 77 } } }],
});

function permutation(n: number): fc.Arbitrary<number[]> {
  const ids = Array.from({ length: n }, (_, i) => i);
  // 约四分之一是恒等排列，其余是任意排列
  return fc.oneof({ weight: 1, arbitrary: fc.constant(ids) }, { weight: 3, arbitrary: fc.shuffledSubarray(ids, { minLength: n, maxLength: n }) });
}

const SAMPLES: ReadonlyArray<readonly [string, fc.Arbitrary<Uint8Array>]> = [
  ["生成样本", roomsWad],
  ["Freedoom 夹具", fc.constant(FIXTURE)],
];

/** 候选按 (重排后下标, 相似度) 比较；候选多于列出的上限时，被截断的部分可能因下标顺序不同而不同，只比较相似度。 */
function mappedCandidates(pin: PinResolution, perm: readonly number[]): Array<[number, number]> {
  return pin.candidates.map((c): [number, number] => [perm[c.index]!, c.score]).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

describe.each(SAMPLES)("Feature: relocation, I-5 扇区重排（%s）", (_label, sample) => {
  it("pin 解析出的目标等于重排后的原目标；歧义在重排后仍是歧义，候选随之换下标", () => {
    const relocated = new Hits();
    const ambiguous = new Hits();
    const arb = sample.chain((bytes) => {
      const wad = WadFile.parse(bytes);
      const maps = wad.maps.filter((m) => m.format === "doom" && m.lumps["SECTORS"] !== undefined);
      return fc.constantFrom(...maps.map((m) => m.name)).chain((map) => {
        const n = wad.recordCount(wad.findMap(map)!.lumps["SECTORS"]!, "Sector");
        return fc.record({ bytes: fc.constant(bytes), map: fc.constant(map), index: fc.integer({ min: 0, max: n - 1 }), perm: permutation(n) });
      });
    });
    fc.assert(
      fc.property(arb, ({ bytes, map, index, perm }) => {
        const fingerprint = wadAdapter.open(bytes).fingerprints!.compute({ scope: map, record: "Sector", index });
        const patch = pinPatch(map, index, fingerprint);
        const moved = permuteSectors(bytes, map, perm);
        const before = planPatch(bytes, patch, wadAdapter);
        const after = planPatch(moved, patch, wadAdapter);
        const p0 = before.pins[0]!;
        const p1 = after.pins[0]!;
        // 记录自己的指纹在原地图上相似度为 1，所以只可能是 EXACT 或歧义
        expect(["EXACT", "CONFLICT_AMBIGUOUS"]).toContain(p0.result);
        expect(p1.fingerprintChecked).toBe(true);
        expect(p1.candidateCount).toBe(p0.candidateCount);
        if (p0.candidateCount <= p0.candidates.length) expect(mappedCandidates(p1, perm.map((_, i) => i))).toEqual(mappedCandidates(p0, perm));
        else expect(p1.candidates.map((c) => c.score)).toEqual(p0.candidates.map((c) => c.score));

        if (p0.result === "CONFLICT_AMBIGUOUS") {
          ambiguous.hit();
          expect(p1.result).toBe("CONFLICT_AMBIGUOUS");
          expect(p1.index).toBeUndefined();
          expect(after.changes).toEqual([]);
          expect(after.issues).toEqual([expect.objectContaining({ code: "CONFLICT_AMBIGUOUS", operationId: "p" })]);
          return;
        }
        const target = perm[index]!;
        const kind = target === index ? "EXACT" : "RELOCATED";
        if (kind === "RELOCATED") relocated.hit();
        expect(p1).toMatchObject({ result: kind, index: target, score: 1, expectedIndex: index });
        expect(after.issues).toEqual([]);
        expect(after.changes).toEqual([
          expect.objectContaining({
            index: target,
            field: "lightlevel",
            oldValue: before.changes[0]!.oldValue,
            selection: { kind, expectedIndex: index, fingerprintChecked: true, score: 1 },
          }),
        ]);
        // 应用后回执经 JSON 往返仍可撤销，得到重排后的输入
        const applied = applyPatch(moved, patch, wadAdapter);
        expect(applied.ok).toBe(true);
        expect(wadAdapter.open(applied.output!).readField({ scope: map, record: "Sector", index: target }, "lightlevel")).toBe(77);
        const back = revertPatch(applied.output!, JSON.parse(JSON.stringify(applied.receipt)), wadAdapter);
        expect(back.issues).toEqual([]);
        expect(sameBytes(back.output!, moved)).toBe(true);
      }),
      { numRuns: RUNS },
    );
    // 两类结果都要真的出现，属性才不是空转
    expect(relocated.n).toBeGreaterThan(RUNS / 4);
    if (_label === "生成样本") expect(ambiguous.n).toBeGreaterThan(0);
  });
});
