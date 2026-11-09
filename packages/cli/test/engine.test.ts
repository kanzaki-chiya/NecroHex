/**
 * 引擎查找（ops.ts 的 findEngine）和 MCP Server 用的工作区根目录查找（workspace.ts 的 findPnpmWorkspaceRoot）。
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.ts";
import { DEFAULT_ENGINE_SUBPATH, findEngine } from "../src/ops.ts";
import { findPnpmWorkspaceRoot } from "../src/workspace.ts";

let dir: string;
beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "necrohex-engine-")));
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

describe("findEngine", () => {
  it("NECROHEX_ENGINE 优先于默认位置，即使它指向的文件不存在", () => {
    expect(findEngine({ NECROHEX_ENGINE: "E:\\x\\dsda.exe", LOCALAPPDATA: "C:\\L" })).toEqual({ path: "E:\\x\\dsda.exe", source: "NECROHEX_ENGINE" });
  });
  it("没有设置（或为空）时用 %LOCALAPPDATA% 下的默认位置", () => {
    const want = join("C:\\L", ...DEFAULT_ENGINE_SUBPATH);
    expect(findEngine({ LOCALAPPDATA: "C:\\L" })).toEqual({ path: want, source: "default" });
    expect(findEngine({ NECROHEX_ENGINE: "", LOCALAPPDATA: "C:\\L" })).toEqual({ path: want, source: "default" });
    expect(DEFAULT_ENGINE_SUBPATH.join("/")).toBe("necrohex/engines/dsda-doom-0.30.1/dsda-doom-0.30.1-win-x64/dsda-doom.exe");
  });
  it("两者都没有时为 null", () => {
    expect(findEngine({})).toEqual({ path: null, source: "default" });
  });
});

describe("findPnpmWorkspaceRoot", () => {
  it("从任意子目录向上找到仓库根目录", () => {
    const repo = resolve(import.meta.dirname, "../../..");
    expect(findPnpmWorkspaceRoot(join(repo, "packages", "mcp-server", "src"))).toBe(repo);
  });
  it("找不到时为 WORKSPACE_NOT_FOUND（临时目录之上没有 pnpm-workspace.yaml）", () => {
    expect(code(() => findPnpmWorkspaceRoot(dir))).toBe("WORKSPACE_NOT_FOUND");
  });
});
