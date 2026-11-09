/**
 * 路径规则（workspace.ts），在进程内直接调用，所有平台规则一致。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.ts";
import { inputPath, openWorkspace, outputPath, type Workspace } from "../src/workspace.ts";

let dir: string;
let ws: Workspace;
beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "necrohex-ws-")));
  mkdirSync(join(dir, "sub"));
  for (const n of ["map.wad", "con1.wad", "nulls.wad", "COM10.wad", "a.b.wad", "CONSOLE.wad"]) writeFileSync(join(dir, n), "x");
  ws = openWorkspace({ root: dir });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const code = (f: () => unknown): string | undefined => {
  try {
    f();
    return undefined;
  } catch (e) {
    return e instanceof ToolError ? e.code : `not a ToolError: ${String(e)}`;
  }
};

describe("Windows 上会写到别处的路径一律拒绝（输入和输出同样的规则）", () => {
  const BAD = [
    "NUL", "nul", "Nul.wad", "nul.tar.gz", "CON", "con.wad", "PRN.txt", "AUX", "aux .wad", "COM0", "COM9.wad", "com\u00b9.wad", "LPT0", "lpt9.wad",
    "CONIN$", "conout$.wad", "sub/NUL/x.wad", "NUL/x.wad",
    "map.wad:hidden", "map.wad::$DATA", "sub/s.wad:zone", "C:relative.wad", "sub:x/map.wad",
    "trail.", "trail ", "map.wad.", "map.wad ", "sub./x.wad", "sub /x.wad",
  ];
  it.each(BAD)("%s", (p) => {
    expect(code(() => outputPath(ws, p))).toBe("INVALID_PATH");
    expect(code(() => inputPath(ws, p))).toBe("INVALID_PATH");
  });

  it("拒绝带有规则名，便于调用方区分", () => {
    const rule = (p: string) => {
      try {
        outputPath(ws, p);
      } catch (e) {
        return ((e as ToolError).details as { rule: string }).rule;
      }
      return undefined;
    };
    expect([rule("NUL"), rule("a.wad:s"), rule("x.")]).toEqual(["device-name", "colon", "trailing-dot-or-space"]);
  });
});

describe("相近但合法的名字照常可用", () => {
  it.each(["map.wad", "con1.wad", "nulls.wad", "COM10.wad", "a.b.wad", "CONSOLE.wad", "./map.wad"])("输入 %s", (p) => {
    expect(inputPath(ws, p)).toBe(resolve(dir, p));
  });
  it("带盘符的绝对路径（Windows）和 ./ 前缀的输出", () => {
    expect(inputPath(ws, join(dir, "map.wad"))).toBe(join(dir, "map.wad"));
    expect(outputPath(ws, "./sub/new.wad")).toBe(join(dir, "sub", "new.wad"));
    expect(outputPath(ws, "LPT10.wad")).toBe(join(dir, "LPT10.wad"));
  });
});
