/**
 * 文件路径的工作区限制。CLI 和 MCP 的每个文件参数都经这里解析：
 * - 路径里不能有 NUL，也不能有 ".." 段（即使解析后仍在工作区内，也一律拒绝，不做“穿越后又回来”的判断）。
 *   另外拒绝 Windows 上会写到别处的名字：附加数据流的冒号、设备名、以点或空格结尾的段（见 checkSyntax）。
 * - 输入文件：解析符号链接后的真实路径必须在工作区根目录（同样解析符号链接）之内，且是普通文件。
 * - 输出文件：父目录必须已存在，父目录的真实路径必须在工作区之内；文件本身必须不存在（包括指向别处的符号链接）。
 *   写入时用独占创建（wx），检查之后才出现的同名文件也不会被覆盖。
 */
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
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

/**
 * Windows 设备名：文件名主体（第一个点之前，去掉末尾空格）是这些名字时，打开的是设备而不是文件，带不带扩展名都一样。
 * 除了 0–9，Windows 也把 COM、LPT 后跟上标 ¹²³ 当作设备名，一并拒绝。
 */
const DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3]|CONIN\$|CONOUT\$)$/i;

/**
 * 路径的语法规则，输入和输出、所有平台都一样：
 * - 不能有 NUL，不能有 ".." 段。
 * - 冒号只能出现在开头的盘符里（"X:"）。其他位置的冒号在 NTFS 上表示附加数据流（"in.wad:hidden"），
 *   或者是相对某个盘当前目录的路径（"C:foo"）。
 * - 任何一段的文件名主体都不能是 Windows 设备名（"NUL"、"nul.wad"、"COM1.txt"），否则写入会进入设备。
 * - 路径段不能以点或空格结尾：Windows 会悄悄去掉它们，写到另一个名字上。单独的 "." 段（当前目录）不算文件名，允许。
 */
function checkSyntax(p: unknown, what: string): string {
  if (typeof p !== "string" || p === "") throw new ToolError("INVALID_ARGUMENT", `${what} must be a non-empty path`);
  const bad = (rule: string, message: string) => new ToolError("INVALID_PATH", `${what} ${JSON.stringify(p)} ${message}`, { rule });
  if (p.includes("\0")) throw bad("nul-character", "contains a NUL character");
  const segments = p.split(/[\\/]+/);
  if (segments.includes("..")) throw new ToolError("PATH_TRAVERSAL", `${what} ${JSON.stringify(p)} contains a ".." segment`);
  segments.forEach((seg, i) => {
    if (seg.includes(":") && !(i === 0 && /^[A-Za-z]:$/.test(seg))) throw bad("colon", "has a colon outside a leading drive letter (an NTFS alternate data stream or a drive-relative path)");
    if (seg === "" || seg === "." || (i === 0 && /^[A-Za-z]:$/.test(seg))) return;
    if (DEVICE_NAME.test(seg.split(".")[0]!.trimEnd())) throw bad("device-name", `has the Windows device name ${JSON.stringify(seg)} as a path segment`);
    if (/[. ]$/.test(seg)) throw bad("trailing-dot-or-space", `has a path segment ${JSON.stringify(seg)} that ends with a dot or a space`);
  });
  return p;
}

/**
 * 从 start 所在目录开始向上找 pnpm-workspace.yaml，返回它所在的目录。MCP Server 在没有 NECROHEX_WORKSPACE 时用它，
 * 这样工作区不取决于启动服务器时的当前目录。找不到时抛 WORKSPACE_NOT_FOUND。
 */
export function findPnpmWorkspaceRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new ToolError("WORKSPACE_NOT_FOUND", `no pnpm-workspace.yaml above ${start}`);
    dir = up;
  }
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
