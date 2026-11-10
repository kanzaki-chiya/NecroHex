import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { gzipSample } from "../scripts/gzip-sample.ts";
import { SAMPLE } from "../src/sample.ts";

const dir = mkdtempSync(join(tmpdir(), "necrohex-gzip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("构建后的样本 gzip", () => {
  it("生成 freedoom2.wad.gz（级别 9），原 WAD 不变，解压后逐字节相同", () => {
    const out = join(dir, "dist");
    mkdirSync(join(out, "freedoom"), { recursive: true });
    // 小的替身数据，不用真实 WAD
    const wad = new Uint8Array(64 * 1024).map((_, i) => (i * 31) & 0xff);
    writeFileSync(join(out, SAMPLE.wadPath), wad);
    const r = gzipSample(out);
    expect(r.path).toBe(join(out, "freedoom", "freedoom2.wad.gz"));
    expect(r.size).toBe(wad.length);
    const gz = readFileSync(r.path);
    expect(gz.length).toBe(r.gzipSize);
    // gzip 头：魔数、deflate、XFL=2 表示最高压缩级别
    expect([gz[0], gz[1], gz[2], gz[8]]).toEqual([0x1f, 0x8b, 8, 2]);
    expect(new Uint8Array(gunzipSync(gz))).toEqual(wad);
    expect(new Uint8Array(readFileSync(join(out, SAMPLE.wadPath)))).toEqual(wad);
  });

  it("输出目录里没有样本 WAD 时报错，不生成文件", () => {
    expect(() => gzipSample(join(dir, "empty"))).toThrow(/is missing/);
  });
});
