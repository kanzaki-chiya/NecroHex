/**
 * 引擎冒烟测试：用外部的 DSDA-Doom 载入 PWAD，在目标地图上运行若干 tic。
 * 用法：node scripts/engine-smoke.ts <dsda-doom 可执行文件> <iwad> <pwad> <map> [tics]
 * 通过时退出码 0，否则 1。只报告通过了哪些检查，不声称地图可以通关。
 */
import { runEngineSmoke } from "../src/node/engine-smoke.ts";

const [engine, iwad, pwad, map, tics] = process.argv.slice(2);
if (!engine || !iwad || !pwad || !map) {
  console.error("usage: node scripts/engine-smoke.ts <dsda-doom> <iwad> <pwad> <map> [tics]");
  process.exit(2);
}
const result = await runEngineSmoke({ engine, iwad, pwad, map, ...(tics ? { tics: Number(tics) } : {}) });
for (const p of result.passed) console.log(`passed: ${p}`);
if (!result.ok) {
  console.log(`FAILED: ${result.failure}`);
  console.log(result.output);
  process.exit(1);
}
