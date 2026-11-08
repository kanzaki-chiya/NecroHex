/**
 * 从完整的 Freedoom IWAD 裁出小型夹具 PWAD。
 * 用法：node scripts/make-freedoom-fixture.ts <freedoom2.wad> <output.wad>
 * 夹具包含 PLAYPAL、ENDOOM 以及 MAP01、MAP02 的完整地图作用域，数据逐字节取自原文件。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildWad, WadFile, type LumpInput } from "../src/index.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node scripts/make-freedoom-fixture.ts <freedoom2.wad> <output.wad>");
  process.exit(2);
}

const wad = WadFile.parse(new Uint8Array(readFileSync(input)));
const lumps: LumpInput[] = [];

function take(index: number): void {
  const l = wad.lumps[index]!;
  const nameBytes = wad.baseBuffer.slice(l.nameSpan.start, l.nameSpan.end);
  const data = l.dataSpan ? wad.baseBuffer.slice(l.dataSpan.start, l.dataSpan.end) : new Uint8Array(0);
  lumps.push({ name: l.name, nameBytes, data });
}

for (const name of ["PLAYPAL", "ENDOOM"]) {
  const l = wad.findLump(name);
  if (!l) throw new Error(`${name} not found`);
  take(l.index);
}
for (const name of ["MAP01", "MAP02"]) {
  const m = wad.findMap(name);
  if (!m) throw new Error(`${name} not found`);
  take(m.markerIndex);
  for (const i of m.dataIndices) take(i);
}

const out = buildWad({ kind: "PWAD", lumps });
writeFileSync(output, out);
console.log(`wrote ${output}: ${out.length} bytes, ${lumps.length} lumps`);
