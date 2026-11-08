/**
 * 手工修改示例（不经过补丁引擎）：把 MAP01 中亮度不低于 160 的扇区亮度减半（下限 32），导出只含 MAP01 的 PWAD。
 * 用法：node scripts/make-dimmed-map01.ts <freedoom2.wad> <output.wad>
 * 输出路径不能与输入相同；源文件只读。
 */
import { readFileSync, realpathSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { exportPwad, WadFile } from "../src/index.ts";

const THRESHOLD = 160;
const FLOOR = 32;

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node scripts/make-dimmed-map01.ts <freedoom2.wad> <output.wad>");
  process.exit(2);
}
const src = realpathSync(input);
if (resolve(output).toLowerCase() === src.toLowerCase() || (existsSync(output) && realpathSync(output).toLowerCase() === src.toLowerCase())) {
  console.error("refusing to overwrite the source file");
  process.exit(2);
}

const wad = WadFile.parse(new Uint8Array(readFileSync(src)));
const map = wad.findMap("MAP01");
if (!map) throw new Error("MAP01 not found");
const lump = wad.mapLump(map, "SECTORS")!.index;
const sectors = wad.readRecords(lump, "Sector");
const changed: string[] = [];
sectors.forEach((s, i) => {
  if (s.lightlevel < THRESHOLD) return;
  const next = Math.max(FLOOR, Math.floor(s.lightlevel / 2));
  wad.setField(lump, "Sector", i, "lightlevel", next);
  changed.push(`#${i} ${s.lightlevel}->${next}`);
});

const out = exportPwad(wad);
writeFileSync(output, out.bytes);
console.log(`dimmed ${changed.length} of ${sectors.length} MAP01 sectors (lightlevel >= ${THRESHOLD} halved, floor ${FLOOR})`);
console.log(changed.join(", "));
for (const m of out.maps) console.log(`${m.name}: ${m.lumps.join(" ")}`);
for (const c of out.checks) console.log(`checked: ${c}`);
console.log(`wrote ${resolve(output)}: ${out.bytes.length} bytes`);
