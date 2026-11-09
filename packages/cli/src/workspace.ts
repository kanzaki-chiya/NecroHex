/**
 * 文件路径的工作区限制。CLI 和 MCP 的每个文件参数都经这里解析：
 * - 路径里不能有 NUL，也不能有 ".." 段（即使解析后仍在工作区内，也一律拒绝，不做“穿越后又回来”的判断）。
 * - 输入文件：解析符号链接后的真实路径必须在工作区根目录（同样解析符号链接）之内，且是普通文件。
 * - 输出文件：父目录必须已存在，父目录的真实路径必须在工作区之内；文件本身必须不存在（包括指向别处的符号链接）。
 *   写入时用独占创建（wx），检查之后才出现的同名文件也不会被覆盖。
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ToolError } from "./errors.ts";

export interface Workspace {
  /** 工作区根目录的真实路径。 */
  readonly root: string;
  /** 相对路径相对于它解析：CLI 用当前目录，MCP 用工作区根目录。 */
  readonly base: string;
}

/** 根目录取 NECROHEX_WORKSPACE，没有设置（或为空）时取当前目录。 */
export function openWorkspace(options: { root?: string | undefined; base?: string | undefined } = {}): Workspace {
  const env = process.env["NECROHEX_WORKSPACE"];
  const want = options.root ?? (env !== undefined && env !== "" ? env : process.cwd());
  let root: string;
  try {
    root = realpathSync.native(resolve(want));
  } catch {
    throw new ToolError("WORKSPACE_NOT_FOUND", `workspace root ${want} does not exist`);
  }
  if (!statSync(root).isDirectory()) throw new ToolError("WORKSPACE_NOT_FOUND", `workspace root ${want} is not a directory`);
  return { root, base: options.base === undefined ? root : resolve(options.base) };
}

function inside(root: string, real: string): boolean {
  const rel = relative(root, real);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function checkSyntax(p: unknown, what: string): string {
  if (typeof p !== "string" || p === "") throw new ToolError("INVALID_ARGUMENT", `${what} must be a non-empty path`);
  if (p.includes("\0")) throw new ToolError("INVALID_PATH", `${what} contains a NUL character`);
  if (p.split(/[\\/]+/).includes("..")) throw new ToolError("PATH_TRAVERSAL", `${what} ${JSON.stringify(p)} contains a ".." segment`);
  return p;
}

/** 已存在的输入文件，返回真实路径。 */
export function inputPath(ws: Workspace, p: unknown, what = "path"): string {
  const raw = checkSyntax(p, what);
  const abs = resolve(ws.base, raw);
  let real: string;
  try {
    real = realpathSync.native(abs);
  } catch {
    throw new ToolError("FILE_NOT_FOUND", `${what} ${JSON.stringify(raw)} does not exist`);
  }
  if (!inside(ws.root, real)) throw new ToolError("PATH_OUTSIDE_WORKSPACE", `${what} ${JSON.stringify(raw)} resolves to a location outside the workspace ${ws.root}`);
  if (!statSync(real).isFile()) throw new ToolError("NOT_A_FILE", `${what} ${JSON.stringify(raw)} is not a regular file`);
  return real;
}

/** 将要新建的输出文件，返回绝对路径。文件已存在时拒绝，绝不覆盖。 */
export function outputPath(ws: Workspace, p: unknown, what = "outputPath"): string {
  const raw = checkSyntax(p, what);
  const abs = resolve(ws.base, raw);
  const name = basename(abs);
  if (name === "" || name === ".") throw new ToolError("INVALID_PATH", `${what} ${JSON.stringify(raw)} has no file name`);
  let parent: string;
  try {
    parent = realpathSync.native(dirname(abs));
  } catch {
    throw new ToolError("FILE_NOT_FOUND", `the directory of ${what} ${JSON.stringify(raw)} does not exist`);
  }
  if (!inside(ws.root, parent)) throw new ToolError("PATH_OUTSIDE_WORKSPACE", `${what} ${JSON.stringify(raw)} is outside the workspace ${ws.root}`);
  const full = join(parent, name);
  let exists = false;
  try {
    lstatSync(full);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) throw new ToolError("OUTPUT_EXISTS", `${what} ${JSON.stringify(raw)} already exists; refusing to overwrite it`);
  return full;
}

/** 显示用：工作区内的相对路径，用 / 分隔。 */
export function display(ws: Workspace, abs: string): string {
  const rel = relative(ws.root, abs);
  return rel === "" ? "." : rel.split(/[\\/]+/).join("/");
}
