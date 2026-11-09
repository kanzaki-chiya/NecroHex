/**
 * 经补丁引擎应用一份 .nhpatch.json，导出只含被修改地图的 PWAD，并写出回执和检查报告。
 * 用法：node scripts/apply-patch.ts <input.wad> <patch.json> <output.wad> [--iwad <base.wad>]
 * --iwad 给出基础 IWAD，新贴图名可以在其中查找；输入本身是 IWAD 时可以省略。
 * 回执写到 <output>.receipt.json，它对应"输入整份 WAD -> 应用后的整份 WAD"，不对应导出的 PWAD。
 * 输出路径不能与输入或基础 IWAD 相同；源文件只读。
 * 报告只列出通过了哪些检查，不声称地图可以通关。
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyPatch } from "@necrohex/core";
import { createWadAdapter, exportPwad, thingInfo, WadFile } from "../src/index.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--iwad");
const iwadPath = at >= 0 ? args[at + 1] : undefined;
if (at >= 0) args.splice(at, 2);
const [input, patchPath, output] = args;
if (!input || !patchPath || !output || (at >= 0 && !iwadPath)) {
  console.error("usage: node scripts/apply-patch.ts <input.wad> <patch.json> <output.wad> [--iwad <base.wad>]");
  process.exit(2);
}

const same = (a: string, b: string) => resolve(a).toLowerCase() === realpathSync(b).toLowerCase() || (existsSync(a) && realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase());
const receiptPath = output.replace(/\.wad$/i, "") + ".receipt.json";
for (const src of [input, ...(iwadPath ? [iwadPath] : [])]) {
  if (same(output, src) || same(receiptPath, src)) {
    console.error(`refusing to overwrite ${src}`);
    process.exit(2);
  }
}

const bytes = new Uint8Array(readFileSync(input));
const base = iwadPath ? new Uint8Array(readFileSync(iwadPath)) : undefined;
const patch = JSON.parse(readFileSync(patchPath, "utf8")) as unknown;
const adapter = createWadAdapter(base ? { baseIwad: base } : {});
const r = applyPatch(bytes, patch, adapter);

for (const m of r.matches) {
  const changed = r.changes.filter((c) => c.operationId === m.operationId && !c.unchanged).length;
  console.log(`operation ${m.operationId}: ${m.count} records matched, ${changed} fields changed`);
}
for (const w of r.warnings) console.log(`WARNING ${w.message}`);
for (const i of r.issues) {
  const where = i.locator ? ` [${i.locator.scope} ${i.locator.record} #${i.locator.index} ${i.field ?? ""}]` : "";
  console.log(`REJECTED ${i.code}${i.reason ? ` ${i.reason}` : ""}${i.hook ? ` ${i.hook}` : ""}${where}: ${i.message}`);
}
for (const c of r.checks) console.log(`check ${c.status}: ${c.name} - ${c.description}`);
if (!r.ok) {
  console.log("patch rejected; nothing was written");
  process.exit(1);
}

// 新 Thing 类型的精灵是否在输入或基础 IWAD 里（只报告，不是护栏）
const sprites = new Set<string>();
for (const w of [WadFile.parse(bytes), ...(base ? [WadFile.parse(base)] : [])]) {
  let inside = false;
  for (const l of w.lumps) {
    const n = l.name.toUpperCase();
    if (/^S{1,2}_START$/.test(n)) inside = true;
    else if (/^S{1,2}_END$/.test(n)) inside = false;
    else if (inside) sprites.add(n.slice(0, 4));
  }
}
const newTypes = new Set(r.changes.filter((c) => c.record === "Thing" && c.field === "type" && !c.unchanged).map((c) => c.newValue as number));
for (const t of newTypes) {
  const info = thingInfo(t);
  const sprite = info?.sprite;
  console.log(`thing type ${t} (${info?.name ?? "unknown"}): sprite ${sprite ?? "none"} ${sprite === null || sprite === undefined ? "" : sprites.has(sprite) ? "found" : "NOT FOUND"}`.trimEnd());
}

const modified = WadFile.parse(r.output!);
const scopes = [...new Set(r.changes.filter((c) => !c.unchanged).map((c) => c.scope))];
const names = scopes.map((id) => modified.maps.find((m) => m.name.toUpperCase() === id.split("@")[0]!.toUpperCase())!.name);
const pwad = exportPwad(modified, { maps: names });
writeFileSync(output, pwad.bytes);
writeFileSync(receiptPath, JSON.stringify(r.receipt, null, 2) + "\n");
for (const m of pwad.maps) console.log(`${m.name}: ${m.lumps.join(" ")}`);
for (const c of pwad.checks) console.log(`export check passed: ${c}`);
console.log(`wrote ${resolve(output)} (${pwad.bytes.length} bytes) and ${resolve(receiptPath)}`);
console.log("these are static checks only; they do not show that the maps can be finished");
