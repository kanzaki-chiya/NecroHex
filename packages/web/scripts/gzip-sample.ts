/**
 * 构建后在输出目录里给内置样本生成 gzip 版本：dist/freedoom/freedoom2.wad -> freedoom2.wad.gz（级别 9），原 WAD 保留。
 * 服务器用 gzip_static 直接发送 .gz，不必每次请求都压缩 28 MB。写出前解压一遍，确认与原 WAD 逐字节相同。
 * vite.config.ts 里的插件在 vite build 结束时调用它；也可以单独运行：node scripts/gzip-sample.ts [dist 目录]
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { constants, gunzipSync, gzipSync } from "node:zlib";
import { SAMPLE } from "../src/sample.ts";

export interface GzipResult {
  readonly path: string;
  readonly size: number;
  readonly gzipSize: number;
}

export function gzipSample(outDir: string): GzipResult {
  const wadPath = join(outDir, SAMPLE.wadPath);
  if (!existsSync(wadPath)) throw new Error(`gzip-sample: ${wadPath} is missing`);
  const wad = readFileSync(wadPath);
  const gz = gzipSync(wad, { level: constants.Z_BEST_COMPRESSION });
  if (!gunzipSync(gz).equals(wad)) throw new Error("gzip-sample: the gzip file does not decompress to the WAD");
  const path = `${wadPath}.gz`;
  writeFileSync(`${path}.tmp`, gz);
  renameSync(`${path}.tmp`, path);
  return { path, size: wad.length, gzipSize: gz.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const r = gzipSample(resolve(process.argv[2] ?? join(import.meta.dirname, "../dist")));
  console.log(`gzip-sample: wrote ${r.path} (${r.size} -> ${r.gzipSize} bytes)`);
}
