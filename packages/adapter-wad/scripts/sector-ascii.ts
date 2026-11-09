/**
 * 抽查用：把两个版本里同一块区域按扇区画成字符图，人工判断重定位是否选对。只用于开发。
 * 用法：node scripts/sector-ascii.ts <src.wad> <dst.wad> <map> <源下标> <选中下标> [<对照下标> ...] [--cell N]
 * 左图是源版本，S 为源扇区；右图是目标版本，C 为被选中的扇区，B、D、E... 为额外给出的对照扇区。
 * 同一格属于多个标出的扇区时显示 *；属于其他扇区为 .；不在任何扇区内为空格。判断内外用面积覆盖的奇偶规则。
 */
import { readFileSync } from "node:fs";
import { WadFile } from "../src/index.ts";
import { mapArea } from "./relocation-controls.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--cell");
const cellArg = at >= 0 ? Number(args[at + 1]) : undefined;
if (at >= 0) args.splice(at, 2);
const [srcPath, dstPath, mapName, srcIdx, chosenIdx, ...others] = args;
if (!srcPath || !dstPath || !mapName || srcIdx === undefined || chosenIdx === undefined) {
  console.error("usage: node scripts/sector-ascii.ts <src.wad> <dst.wad> <map> <src> <chosen> [<other> ...] [--cell N]");
  process.exit(2);
}
const open = (p: string) => {
  const w = WadFile.parse(new Uint8Array(readFileSync(p)));
  return { w, m: w.findMap(mapName)! };
};
const A = open(srcPath);
const B = open(dstPath);
const aa = mapArea(A.w, A.m);
const ba = mapArea(B.w, B.m);
const s = Number(srcIdx);
const marks: Array<[number, string]> = [[Number(chosenIdx), "C"], ...others.map((o, i): [number, string] => [Number(o), "BDEFGH"[i] ?? "?"])];

// 区域：源扇区和标出扇区的采样点范围，外扩一圈
const pts = [...aa.samples[s]!, ...marks.flatMap(([i]) => ba.samples[i] ?? [])];
const xs = pts.map((p) => p[0]);
const ys = pts.map((p) => p[1]);
const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
const cell = cellArg ?? Math.max(1, Math.ceil(span / 48));
const minX = Math.floor((Math.min(...xs) - 2 * cell) / cell) * cell;
const maxX = Math.ceil((Math.max(...xs) + 2 * cell) / cell) * cell;
const minY = Math.floor((Math.min(...ys) - 2 * cell) / cell) * cell;
const maxY = Math.ceil((Math.max(...ys) + 2 * cell) / cell) * cell;
console.log(`${mapName} 源 #${s}；${marks.map(([i, c]) => `${c}=#${i}`).join(" ")}；x ${minX}..${maxX}，y ${minY}..${maxY}，每格 ${cell} 单位，上方为 +y`);
for (let y = maxY - cell / 2; y > minY; y -= cell) {
  let left = "";
  let right = "";
  for (let x = minX + cell / 2; x < maxX; x += cell) {
    const px = x + 0.137;
    const py = y + 0.291;
    const ia = aa.sectorsAt(px, py);
    left += ia.includes(s) ? "S" : ia.length > 0 ? "." : " ";
    const ib = ba.sectorsAt(px, py);
    const hit = marks.filter(([i]) => ib.includes(i));
    right += hit.length > 1 ? "*" : hit.length === 1 ? hit[0]![1] : ib.length > 0 ? "." : " ";
  }
  console.log(`${left} | ${right}`);
}
