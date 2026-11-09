/**
 * NecroHex MCP Server：恰好五个工具 inspect_wad、query_entities、plan_patch、apply_patch、verify_output（docs/design.md 第 12 节）。
 * 每个工具都是 @necrohex/cli/ops 的薄封装，补丁逻辑全部在引擎里。
 * 没有写裸字节、按偏移写入或执行任意命令的工具。引擎路径来自服务器的环境变量 NECROHEX_ENGINE，不是工具参数。
 * apply_patch 只接受本服务器 plan_patch 发出、且补丁、输入和基础 IWAD 都没有变的 planId；每个 planId 只能用一次。
 * 错误一律以结构化结果返回（isError: true），不让服务器退出。日志只写 stderr，stdout 只给 MCP 协议。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorJson, toToolError, ToolError } from "@necrohex/cli/errors";
import { apply, inspect, plan, query, verify } from "@necrohex/cli/ops";
import { openWorkspace, type Workspace } from "@necrohex/cli/workspace";

export const TOOL_NAMES = ["inspect_wad", "query_entities", "plan_patch", "apply_patch", "verify_output"] as const;

const log = (msg: string) => process.stderr.write(`[necrohex-mcp] ${msg}\n`);

function ok(value: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function fail(e: unknown, tool: string): CallToolResult {
  const t = toToolError(e);
  if (!(e instanceof ToolError)) log(`${tool}: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  const body = errorJson(t);
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }], structuredContent: body };
}

const path = z.string().min(1);
const patchArgs = {
  inputPath: path.describe("WAD to patch, inside the workspace. It is only read."),
  patch: z.record(z.string(), z.unknown()).optional().describe("The patch as a JSON object (give this or patchPath)."),
  patchPath: path.optional().describe("A .nhpatch.json file inside the workspace (give this or patch)."),
  iwadPath: path.optional().describe("Base IWAD for looking up flat names, e.g. packages/adapter-wad/fixtures/cache/freedoom2.wad."),
};

export interface ServerOptions {
  /** 工作区根目录；默认 NECROHEX_WORKSPACE，再默认当前目录。 */
  readonly root?: string;
}

export function createServer(options: ServerOptions = {}): { server: McpServer; workspace: Workspace } {
  const ws = openWorkspace(options.root === undefined ? {} : { root: options.root });
  const server = new McpServer({ name: "necrohex", version: "0.0.0" }, { capabilities: { tools: {} } });
  /** 本进程发出的、还没有用掉的 planId。服务器重启后全部失效。 */
  const issued = new Set<string>();

  const run = async (tool: string, f: () => object | Promise<object>): Promise<CallToolResult> => {
    try {
      return ok(await f());
    } catch (e) {
      return fail(e, tool);
    }
  };

  server.registerTool(
    "inspect_wad",
    {
      title: "Inspect a WAD",
      description: "List the maps, lumps and record counts of a WAD file inside the workspace. Read-only.",
      inputSchema: {
        path: path.describe("WAD file inside the workspace."),
        includeLumps: z.boolean().optional().describe("Also list every lump (name and size)."),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => run("inspect_wad", () => inspect(ws, a)),
  );

  server.registerTool(
    "query_entities",
    {
      title: "Query sectors and things",
      description:
        "Select records with the same selector a patch uses: {record, where} with eq/ne/lt/lte/gt/gte/in conditions, {record, pin: {map, expectedIndex, fingerprint?}}, or {record, all: true}. " +
        "Returns field values; with includeFingerprint, Sector fingerprints you can paste into a pin. Read-only.",
      inputSchema: {
        path: path.describe("WAD file inside the workspace."),
        select: z.record(z.string(), z.unknown()).describe('Selector, e.g. {"record":"Thing","where":{"type":{"eq":1}}}.'),
        maps: z.union([z.literal("*"), z.array(z.string().min(1)).min(1)]).optional().describe('Map names, default "*".'),
        fields: z.array(z.string().min(1)).optional(),
        limit: z.number().int().min(1).max(1000).optional().describe("Default 100."),
        includeFingerprint: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => run("query_entities", () => query(ws, a)),
  );

  server.registerTool(
    "plan_patch",
    {
      title: "Dry-run a patch",
      description:
        "Validate a patch and dry-run it. Writes nothing. Returns match counts, the field diff, warnings, rejection reasons and every pin result (expectedIndex → index, score). " +
        "RELOCATED pins are relocated and must be reviewed; they are not confirmed correct. A ready plan returns a planId bound to the patch hash, input hash and base IWAD hash; apply_patch needs it.",
      inputSchema: { ...patchArgs, diffLimit: z.number().int().min(0).max(5000).optional().describe("Most diff entries to list, default 200.") },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      run("plan_patch", () => {
        const r = plan(ws, a);
        if (r.planId !== null) issued.add(r.planId);
        return r;
      }),
  );

  server.registerTool(
    "apply_patch",
    {
      title: "Apply a planned patch",
      description:
        "Apply a patch that plan_patch accepted. Requires the planId from plan_patch; refuses if the patch, input or base IWAD changed. " +
        "Writes a PWAD and a receipt as new files inside the workspace; never overwrites an existing file, the input or the base IWAD. Optionally also writes the full patched WAD.",
      inputSchema: {
        ...patchArgs,
        planId: z.string().optional().describe("planId returned by plan_patch. Required."),
        outputPath: path.describe("New PWAD file to write."),
        receiptPath: path.optional().describe("New receipt file; default <outputPath without .wad>.receipt.json."),
        fullOutputPath: path.optional().describe("Also write the full patched WAD here (new file)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (a) =>
      run("apply_patch", () => {
        if (a.planId === undefined || a.planId === "") throw new ToolError("PLAN_REQUIRED", "apply_patch needs the planId returned by plan_patch; run plan_patch first");
        if (!issued.has(a.planId)) throw new ToolError("PLAN_UNKNOWN", "planId was not issued by this server, was already used, or the server restarted; run plan_patch again");
        const r = apply(ws, a);
        if (r.status === "applied") issued.delete(a.planId);
        return r;
      }),
  );

  server.registerTool(
    "verify_output",
    {
      title: "Verify a patched output",
      description:
        "Check the invariants of an apply_patch result: receipt hashes, locality (I-3), revert (I-4) and PWAD map completeness. Runs the engine smoke test when the server has NECROHEX_ENGINE set and iwadPath is given. " +
        "If the engine did not run the status is incomplete, not passed. No result means the map can be finished.",
      inputSchema: {
        inputPath: path.describe("The original input given to apply_patch."),
        outputPath: path.describe("The PWAD written by apply_patch."),
        receiptPath: path.describe("The receipt written by apply_patch."),
        fullOutputPath: path.optional(),
        iwadPath: path.optional().describe("Base IWAD for the engine, e.g. packages/adapter-wad/fixtures/cache/freedoom2.wad."),
        tics: z.number().int().min(1).max(21000).optional().describe("Tics per map, default 350."),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => run("verify_output", () => verify(ws, a)),
  );

  return { server, workspace: ws };
}
