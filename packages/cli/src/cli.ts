/**
 * necrohex 命令行：ops.ts 的薄封装，只负责解析参数和打印结果。
 * 退出码：0 成功；1 补丁被拒绝、校验失败或不完整、文件内容有问题；2 用法错误（参数、路径、已存在的输出）。
 */
import { errorJson, toToolError, ToolError } from "./errors.ts";
import { apply, inspect, plan, query, revert, STATIC_ONLY, verify } from "./ops.ts";
import { openWorkspace } from "./workspace.ts";

export const USAGE = `usage: necrohex <command> [options] [--json]

  inspect <wad> [--lumps]
  query   <wad> --select <selector-json> [--maps MAP01,MAP02] [--fields a,b] [--limit N] [--fingerprint]
  plan    <wad> <patch.json> [--iwad <wad>] [--diff-limit N]
  apply   <wad> <patch.json> <out.wad> [--receipt <path>] [--full <path>] [--iwad <wad>] [--plan-id <id>]
  revert  <patched-full.wad> <receipt.json> <out.wad>
  verify  <input.wad> <out.wad> <receipt.json> [--full <path>] [--iwad <wad>] [--tics N]

Paths must be inside the workspace (NECROHEX_WORKSPACE, default: the current directory).
Outputs must not exist yet; nothing is ever overwritten. Windows device names (NUL, CON, COM1 ...), colons after the drive
letter and path segments ending in a dot or space are refused. verify runs the engine from NECROHEX_ENGINE, or else from
%LOCALAPPDATA%\\necrohex\\engines\\dsda-doom-0.30.1\\dsda-doom-0.30.1-win-x64\\dsda-doom.exe; if neither exists it reports "engine not run".
Exit codes: 0 success, 1 patch rejected or verification failed or incomplete, 2 usage error.`;

export interface CliIo {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
}

const FLAGS: Readonly<Record<string, "value" | "bool">> = {
  "--json": "bool",
  "--lumps": "bool",
  "--fingerprint": "bool",
  "--select": "value",
  "--maps": "value",
  "--fields": "value",
  "--limit": "value",
  "--iwad": "value",
  "--diff-limit": "value",
  "--receipt": "value",
  "--full": "value",
  "--plan-id": "value",
  "--tics": "value",
};

const ALLOWED: Readonly<Record<string, { positional: number; flags: readonly string[] }>> = {
  inspect: { positional: 1, flags: ["--lumps"] },
  query: { positional: 1, flags: ["--select", "--maps", "--fields", "--limit", "--fingerprint"] },
  plan: { positional: 2, flags: ["--iwad", "--diff-limit"] },
  apply: { positional: 3, flags: ["--receipt", "--full", "--iwad", "--plan-id"] },
  revert: { positional: 3, flags: [] },
  verify: { positional: 3, flags: ["--full", "--iwad", "--tics"] },
};

class UsageError extends Error {}

function parse(argv: readonly string[]) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") return { help: true as const };
  const spec = ALLOWED[command];
  if (!spec) throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const kind = FLAGS[a];
      if (!kind || (a !== "--json" && !spec.flags.includes(a))) throw new UsageError(`unknown option ${a} for ${command}`);
      if (flags.has(a)) throw new UsageError(`${a} given twice`);
      if (kind === "bool") flags.set(a, true);
      else {
        const v = rest[++i];
        if (v === undefined) throw new UsageError(`${a} needs a value`);
        flags.set(a, v);
      }
    } else pos.push(a);
  }
  if (pos.length !== spec.positional) throw new UsageError(`${command} takes ${spec.positional} path argument(s), got ${pos.length}`);
  const str = (f: string) => {
    const v = flags.get(f);
    return typeof v === "string" ? v : undefined;
  };
  const int = (f: string) => {
    const v = str(f);
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v)) throw new UsageError(`${f} must be a non-negative integer`);
    return Number(v);
  };
  const list = (f: string) => str(f)?.split(",").map((s) => s.trim()).filter((s) => s !== "");
  return { help: false as const, command, pos, json: flags.has("--json"), str, int, list, bool: (f: string) => flags.get(f) === true };
}

function jsonArg(text: string | undefined, name: string): unknown {
  if (text === undefined) throw new UsageError(`${name} is required`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UsageError(`${name} must be JSON`);
  }
}

// ---------------------------------------------------------------------------
// 文本输出

type Report = Record<string, unknown>;

function lines(command: string, r: Report): string[] {
  const out: string[] = [];
  const pins = (r["pins"] as Array<{ label: string; operationId: string }> | undefined) ?? [];
  const issues = (r["issues"] as Array<{ code: string; message: string; path?: string }> | undefined) ?? [];
  const warnings = (r["warnings"] as Array<{ message: string }> | undefined) ?? [];
  const showIssues = () => issues.forEach((i) => out.push(`REJECTED ${i.code}${i.path ? ` ${i.path}` : ""}: ${i.message}`));
  if (command === "inspect") {
    out.push(`${r["path"]}: ${r["kind"]}, ${r["lumpCount"]} lumps, ${r["size"]} bytes, ${r["sha256"]}`);
    for (const m of r["maps"] as Array<{ name: string; format: string; records: Record<string, number> | null }>) {
      out.push(`${m.name} (${m.format})${m.records ? ": " + Object.entries(m.records).map(([k, v]) => `${k} ${v}`).join(", ") : ""}`);
    }
  } else if (command === "query") {
    out.push(`${r["status"]}: ${r["total"]} record(s), showing ${r["returned"]}`);
    for (const x of r["records"] as Array<{ map: string; record: string; index: number; fields: Record<string, unknown> }>) out.push(`${x.map} ${x.record} #${x.index} ${JSON.stringify(x.fields)}`);
    pins.forEach((p) => out.push(`pin ${p.operationId}: ${p.label}`));
    showIssues();
  } else if (command === "plan" || command === "apply") {
    out.push(`status: ${r["status"]}${r["planId"] ? `  planId: ${r["planId"]}` : ""}`);
    for (const m of (r["matches"] as Array<{ operationId: string; count: number }> | undefined) ?? []) out.push(`operation ${m.operationId}: ${m.count} records matched`);
    if (r["changedCount"] !== undefined) out.push(`${r["changedCount"]} field(s) change`);
    pins.forEach((p) => out.push(`pin ${p.operationId}: ${p.label}`));
    warnings.forEach((w) => out.push(`WARNING ${w.message}`));
    showIssues();
    if (command === "apply" && r["status"] === "applied") out.push(`wrote ${(r["written"] as string[]).join(", ")}`);
    out.push(String(r["note"] ?? STATIC_ONLY));
  } else if (command === "revert") {
    out.push(`status: ${r["status"]}`);
    showIssues();
    if (r["status"] === "reverted") out.push(`wrote ${r["outputPath"]} (${r["outputSha256"]}); matches the receipt's input hash: ${r["matchesReceiptInput"]}`);
  } else if (command === "verify") {
    out.push(`status: ${r["status"]}`);
    for (const c of r["checks"] as Array<{ name: string; status: string; detail: string }>) out.push(`${c.status}: ${c.name} - ${c.detail}`);
    const e = r["engine"] as { status: string; reason: string; path: string | null; source: string; runs: Array<{ map: string; ok: boolean; passed: string[]; failure?: string }> };
    out.push(`engine ${e.status}: ${e.reason}`);
    out.push(`engine path: ${e.path ?? "none"} (from ${e.source})`);
    for (const run of e.runs) out.push(`  ${run.map}: ${run.ok ? "passed" : `FAILED (${run.failure})`}${run.passed.length ? ` - ${run.passed.join("; ")}` : ""}`);
    out.push(String(r["note"]));
  }
  return out;
}

function failedStatus(command: string, r: Report): boolean {
  if (command === "verify") return r["status"] !== "passed";
  return r["status"] === "rejected";
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let json = argv.includes("--json");
  let command = argv[0] ?? "";
  try {
    const a = parse(argv);
    if (a.help) {
      io.out(USAGE);
      return 0;
    }
    json = a.json;
    command = a.command;
    const ws = openWorkspace({ base: process.cwd() });
    const [p0, p1, p2] = a.pos as [string, string, string];
    let r: Report;
    if (a.command === "inspect") r = inspect(ws, { path: p0, includeLumps: a.bool("--lumps") });
    else if (a.command === "query") {
      r = query(ws, { path: p0, select: jsonArg(a.str("--select"), "--select"), maps: a.list("--maps"), fields: a.list("--fields"), limit: a.int("--limit"), includeFingerprint: a.bool("--fingerprint") });
    } else if (a.command === "plan") r = plan(ws, { inputPath: p0, patchPath: p1, iwadPath: a.str("--iwad"), diffLimit: a.int("--diff-limit") });
    else if (a.command === "apply") {
      r = apply(ws, { inputPath: p0, patchPath: p1, outputPath: p2, receiptPath: a.str("--receipt"), fullOutputPath: a.str("--full"), iwadPath: a.str("--iwad"), planId: a.str("--plan-id") });
    } else if (a.command === "revert") r = revert(ws, { inputPath: p0, receiptPath: p1, outputPath: p2 });
    else r = await verify(ws, { inputPath: p0, outputPath: p1, receiptPath: p2, fullOutputPath: a.str("--full"), iwadPath: a.str("--iwad"), tics: a.int("--tics") });
    io.out(json ? JSON.stringify(r, null, 2) : lines(a.command, r).join("\n"));
    return failedStatus(a.command, r) ? 1 : 0;
  } catch (e) {
    if (e instanceof UsageError) {
      if (json) io.out(JSON.stringify({ error: { code: "USAGE", message: e.message } }, null, 2));
      else io.err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    const t = toToolError(e);
    if (json) io.out(JSON.stringify(errorJson(t), null, 2));
    else io.err(`error ${t.code}${command ? ` (${command})` : ""}: ${t.message}`);
    return t instanceof ToolError && t.usage ? 2 : 1;
  }
}
