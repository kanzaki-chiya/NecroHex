import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// core 的 tsconfig 不带 Node 类型，读取 package.json 的断言放在这个包里
const corePackage = resolve(import.meta.dirname, "../../core/package.json");

describe("@necrohex/core 的 package.json exports", () => {
  it("只有公开入口 '.' 和内部入口 './internal'", () => {
    const pkg = JSON.parse(readFileSync(corePackage, "utf8")) as { exports: Record<string, string> };
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./internal"]);
  });
});
