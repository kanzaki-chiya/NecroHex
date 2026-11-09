import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// core 的 tsconfig 不带 Node 类型，读取文件的断言放在这个包里
const coreRoot = resolve(import.meta.dirname, "../../core");
const corePackage = resolve(coreRoot, "package.json");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

/** 去掉注释，只扫描代码。core/src 里没有含 // 或 /* 的字符串字面量。 */
function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("@necrohex/core 的 package.json exports", () => {
  it("只有公开入口 '.' 和内部入口 './internal'", () => {
    const pkg = JSON.parse(readFileSync(corePackage, "utf8")) as { exports: Record<string, string> };
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./internal"]);
  });
});

describe("@necrohex/core 的源码约束", () => {
  const files = sources(resolve(coreRoot, "src"));

  it("扫描到了补丁引擎的源码", () => {
    const names = files.map((f) => relative(coreRoot, f).replace(/\\/g, "/"));
    for (const f of ["src/hash.ts", "src/patch/engine.ts", "src/patch/restorable.ts"]) expect(names).toContain(f);
  });

  it.each(["adapter-wad", "node:", "TextEncoder", "crypto"])("代码中不出现 %s", (word) => {
    for (const f of files) expect(code(f).includes(word), relative(coreRoot, f)).toBe(false);
  });

  it("lookupRestorer 只出现在 restorable.ts 和 engine.ts", () => {
    const users = files.filter((f) => code(f).includes("lookupRestorer")).map((f) => relative(coreRoot, f).replace(/\\/g, "/"));
    expect(users.sort()).toEqual(["src/patch/engine.ts", "src/patch/restorable.ts"]);
  });

  it("core 的 tsconfig 不带 DOM 和 Node 类型", () => {
    const base = JSON.parse(readFileSync(resolve(coreRoot, "../../tsconfig.base.json"), "utf8")) as { compilerOptions: { lib: string[]; types: string[] } };
    const own = JSON.parse(readFileSync(resolve(coreRoot, "tsconfig.json"), "utf8")) as { compilerOptions?: { lib?: string[]; types?: string[] } };
    const lib = own.compilerOptions?.lib ?? base.compilerOptions.lib;
    const types = own.compilerOptions?.types ?? base.compilerOptions.types;
    expect(lib.some((l) => /dom/i.test(l))).toBe(false);
    expect(types).toEqual([]);
  });
});
