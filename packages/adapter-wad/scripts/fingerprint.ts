/**
 * 打印扇区的语义指纹，用于写 pin 的 fingerprint。
 * 用法：node scripts/fingerprint.ts <input.wad> <map> <index>
 * 输出可以直接粘贴到补丁的 select.pin.fingerprint，并顺带打印这个指纹在同一张图上的解析结果。
 */
import { readFileSync } from "node:fs";
import { planPatch } from "@necrohex/core";
import { wadAdapter } from "../src/index.ts";

const [input, map, index] = process.argv.slice(2);
if (!input || !map || index === undefined || !/^\d+$/.test(index)) {
  console.error("usage: node scripts/fingerprint.ts <input.wad> <map> <index>");
  process.exit(2);
}
const bytes = new Uint8Array(readFileSync(input));
const source = wadAdapter.open(bytes);
const scope = source.scopes().find((s) => s.name.toUpperCase() === map.toUpperCase());
if (!scope) {
  console.error(`no Doom-format map ${map} in ${input}`);
  process.exit(1);
}
const fingerprint = source.fingerprints!.compute({ scope: scope.id, record: "Sector", index: Number(index) });
console.log(JSON.stringify(fingerprint));
// 同一张图上自检：有相近的扇区时，这个 pin 在原图上就会是 CONFLICT_AMBIGUOUS
const patch = {
  schemaVersion: 1,
  name: "fingerprint check",
  target: { format: "wad", maps: [scope.name] },
  operations: [{ id: "check", select: { record: "Sector", pin: { map: scope.name, expectedIndex: Number(index), fingerprint } }, change: { lightlevel: { scale: 1 } } }],
};
const pin = planPatch(bytes, patch, wadAdapter).pins[0]!;
console.error(`${pin.result}: ${pin.message}`);
