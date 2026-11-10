/**
 * 构建前准备内置样本：下载 Freedoom 0.13.0 的 zip（或用 NECROHEX_FREEDOOM_ZIP 指向的本地文件），
 * 校验 zip 的 SHA-256，解出 freedoom2.wad 和 COPYING.txt 到 public/freedoom/，再校验 WAD 的 SHA-256。
 * 任一校验失败就退出并删掉未通过校验的文件。下载的 zip 缓存在 .cache/，两处都被 git 忽略，不进仓库。
 * 用法：node scripts/fetch-freedoom.ts
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { SAMPLE } from "../src/sample.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CACHE = join(ROOT, ".cache");
const OUT = join(ROOT, "public");
const zipCache = join(CACHE, "freedoom-0.13.0.zip");
const wadOut = join(OUT, SAMPLE.wadPath);
const copyingOut = join(OUT, SAMPLE.copyingPath);

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function fail(message: string): never {
  console.error(`fetch-freedoom: ${message}`);
  process.exit(1);
}

/** zip 中央目录里的一项。只支持本脚本需要的 stored（0）和 deflate（8）。 */
function extract(zip: Uint8Array, wanted: string): Uint8Array {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail("not a zip file (no end of central directory)");
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(at, true) !== 0x02014b50) fail("bad central directory entry");
    const method = v.getUint16(at + 10, true);
    const compressed = v.getUint32(at + 20, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;
    if (v.getUint32(local, true) !== 0x04034b50) fail(`bad local header for ${name}`);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = zip.subarray(start, start + compressed);
    const data = method === 0 ? raw.slice() : method === 8 ? new Uint8Array(inflateRawSync(raw)) : fail(`${name}: unsupported compression method ${method}`);
    if (data.length !== size) fail(`${name}: expected ${size} bytes, got ${data.length}`);
    return data;
  }
  return fail(`${wanted} is not in the zip`);
}

async function loadZip(): Promise<Uint8Array> {
  const local = process.env["NECROHEX_FREEDOOM_ZIP"];
  if (local) {
    if (!existsSync(local)) fail(`NECROHEX_FREEDOOM_ZIP points to a missing file ${local}`);
    console.log(`fetch-freedoom: using ${local}`);
    return new Uint8Array(readFileSync(local));
  }
  if (existsSync(zipCache)) return new Uint8Array(readFileSync(zipCache));
  console.log(`fetch-freedoom: downloading ${SAMPLE.zipUrl}`);
  const res = await fetch(SAMPLE.zipUrl);
  if (!res.ok) fail(`download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes;
}

function writeAtomic(path: string, data: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

if (existsSync(wadOut) && existsSync(copyingOut) && sha256(readFileSync(wadOut)) === SAMPLE.wadSha256) {
  console.log(`fetch-freedoom: ${SAMPLE.wadPath} is present and its sha256 matches`);
  process.exit(0);
}
rmSync(wadOut, { force: true });

const zip = await loadZip();
const zipHash = sha256(zip);
if (zipHash !== SAMPLE.zipSha256) {
  rmSync(zipCache, { force: true });
  fail(`zip sha256 ${zipHash} does not match the official checksum ${SAMPLE.zipSha256}`);
}
if (!existsSync(zipCache)) writeAtomic(zipCache, zip);

const wad = extract(zip, SAMPLE.wadEntry);
const wadHash = sha256(wad);
if (wadHash !== SAMPLE.wadSha256) fail(`${SAMPLE.wadEntry} sha256 ${wadHash} does not match ${SAMPLE.wadSha256}`);
writeAtomic(copyingOut, extract(zip, SAMPLE.copyingEntry));
writeAtomic(wadOut, wad);
console.log(`fetch-freedoom: wrote ${SAMPLE.wadPath} (${wad.length} bytes, sha256 ${wadHash}) and ${SAMPLE.copyingPath}`);
