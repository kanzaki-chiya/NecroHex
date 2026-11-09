/**
 * cli 和 mcp-server 只能用 @necrohex/core、@necrohex/adapter-wad 的公开导出：
 * 不能导入 @necrohex/core/internal（ByteOverlay、写回通道），不能深入其他包的 src，不能用相对路径跨出自己的包。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES = resolve(import.meta.dirname, "../..");
const CHECKED = ["cli", "mcp-server"];
/** 允许的 @necrohex/* 说明符，都是对应 package.json exports 里列出的入口。 */
const ALLOWED = new Set(["@necrohex/core", "@necrohex/adapter-wad", "@necrohex/adapter-wad/node", "@necrohex/cli/ops", "@necrohex/cli/errors", "@necrohex/cli/workspace", "@necrohex/cli/cli"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === "node_modules") return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|mts|js|mjs)$/.test(n) ? [p] : [];
  });
}

function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /\b(?:import|export)\b[^'"]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3] ?? m[4])!);
  return out;
}

describe("cli 和 mcp-server 的导入", () => {
  const all = CHECKED.flatMap((p) => files(join(PACKAGES, p)).map((f) => ({ pkg: p, file: f })));

  it("扫描到了两个包的源码", () => {
    expect(all.some((f) => f.pkg === "cli" && f.file.endsWith(`${sep}ops.ts`))).toBe(true);
    expect(all.some((f) => f.pkg === "mcp-server" && f.file.endsWith(`${sep}server.ts`))).toBe(true);
  });

  it("没有 @necrohex/core/internal、没有深入其他包、没有跨包相对路径", () => {
    const bad: string[] = [];
    for (const { pkg, file } of all) {
      const root = join(PACKAGES, pkg);
      for (const s of specifiers(readFileSync(file, "utf8"))) {
        const where = `${relative(PACKAGES, file)}: ${s}`;
        if (s.startsWith("@necrohex/")) {
          if (!ALLOWED.has(s)) bad.push(where);
        } else if (s.startsWith(".")) {
          if (relative(root, resolve(file, "..", s)).startsWith("..")) bad.push(where);
        } else if (/(^|[\\/])packages[\\/]|adapter-wad[\\/]src|core[\\/]src/.test(s)) bad.push(where);
      }
    }
    expect(bad).toEqual([]);
  });

  it("这条规则本身能发现违规的写法", () => {
    // 样例用拼接构造，否则上面的扫描会把这个测试文件本身判为违规
    const internal = "@necrohex/core" + "/internal";
    const deep = "../../core" + "/src/overlay.ts";
    const q = '"';
    expect(specifiers(`import { ByteOverlay } from ${q}${internal}${q};`)).toEqual([internal]);
    expect(specifiers(`const m = await import(${q}${internal}${q});`)).toEqual([internal]);
    expect(specifiers(`export * from ${q}${deep}${q};`)).toEqual([deep]);
    expect(ALLOWED.has(internal)).toBe(false);
  });
});
