import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as core from "@necrohex/core";
import * as coreInternal from "@necrohex/core/internal";
import { describe, expect, it } from "vitest";
import * as adapter from "../src/index.ts";
import * as nodeEntry from "../src/node/engine-smoke.ts";
import { buildWad, MAP_DATA_LUMPS, wadAdapter, WadFile } from "../src/index.ts";

const FORBIDDEN = ["restoreField", "installRestore", "restoreWadField", "openRestorable", "lookupRestorer", "encodeRestoreValue"];

/** 值本身及其原型链上的全部键（字符串键和符号键的描述）。 */
function allKeys(value: unknown): string[] {
  const out: string[] = [];
  let o: unknown = value;
  const seen = new Set<unknown>();
  while (o !== null && (typeof o === "object" || typeof o === "function") && !seen.has(o)) {
    seen.add(o);
    out.push(...Object.getOwnPropertyNames(o));
    out.push(...Object.getOwnPropertySymbols(o).map((s) => s.description ?? s.toString()));
    o = Object.getPrototypeOf(o);
  }
  return out;
}

function expectClean(entry: Record<string, unknown>, label: string): void {
  for (const name of FORBIDDEN) expect(Object.keys(entry), `${label} exports ${name}`).not.toContain(name);
  for (const [k, v] of Object.entries(entry)) {
    for (const name of FORBIDDEN) expect(allKeys(v), `${label}.${k}`).not.toContain(name);
    // 类的原型
    if (typeof v === "function" && v.prototype) for (const name of FORBIDDEN) expect(allKeys(v.prototype), `${label}.${k}.prototype`).not.toContain(name);
  }
}

describe("adapter-wad 公开入口不暴露写回通道", () => {
  it("主入口和 ./node 的导出值及原型链（含符号键）", () => {
    expectClean(adapter as unknown as Record<string, unknown>, "adapter-wad");
    expectClean(nodeEntry as unknown as Record<string, unknown>, "adapter-wad/node");
  });

  it("core 的两个入口", () => {
    expectClean(core as unknown as Record<string, unknown>, "core");
    expect(Object.keys(coreInternal).sort()).toEqual(["ByteOverlay", "registerRestorer"]);
  });

  it("WadFile.prototype 上没有 restoreField", () => {
    expect(allKeys(WadFile.prototype)).not.toContain("restoreField");
    expect("restoreField" in WadFile.prototype).toBe(false);
  });

  it("open() 的返回值没有 restoreField", () => {
    const bytes = buildWad({ kind: "PWAD", lumps: [{ name: "MAP01", data: new Uint8Array(0) }, ...MAP_DATA_LUMPS.map((name) => ({ name, data: new Uint8Array(26) }))] });
    const src = wadAdapter.open(bytes);
    expect(allKeys(src)).not.toContain("restoreField");
    expect("restoreField" in src).toBe(false);
  });

  it("wadAdapter 的自有键恰为 format、open、hooks，没有符号键", () => {
    expect(Reflect.ownKeys(wadAdapter).map(String).sort()).toEqual(["format", "hooks", "open"]);
    expect(Object.getOwnPropertySymbols(wadAdapter)).toEqual([]);
    expect(wadAdapter.format).toBe("wad");
  });

  it("adapter-wad 的 exports 恰为 . 和 ./node", () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as { exports: Record<string, string> };
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./node"]);
  });

  it("主入口只新增了 wadAdapter 这一个补丁相关的值", () => {
    expect(typeof adapter.wadAdapter).toBe("object");
    expect(Object.keys(adapter).filter((k) => /restor|adapter|record-source/i.test(k))).toEqual(["wadAdapter"]);
  });
});
