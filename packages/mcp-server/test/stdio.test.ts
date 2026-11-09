/**
 * 用官方 SDK 的 stdio 客户端启动真实的服务器进程（node src/main.ts），在临时工作区里按工具调用。
 * 输入是 packages/adapter-wad/fixtures/freedoom/freedoom2-map01-02.wad 的副本。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../../..");
const FIXTURE = join(REPO, "packages/adapter-wad/fixtures/freedoom/freedoom2-map01-02.wad");
const CACHE_IWAD = join(REPO, "packages/adapter-wad/fixtures/cache/freedoom2.wad");
const SERVER = join(REPO, "packages/mcp-server/src/main.ts");
const CLI = join(REPO, "packages/cli/src/main.ts");
const T = { timeout: 120_000 };

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** 不含 NECROHEX_ENGINE 的环境，另加工作区。 */
function envFor(workspace: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "NECROHEX_ENGINE" && k !== "NECROHEX_WORKSPACE") env[k] = v;
  return { ...env, NECROHEX_WORKSPACE: workspace, ...extra };
}

interface Session {
  readonly client: Client;
  readonly stderr: () => string;
  call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, any> }>;
  close(): Promise<void>;
}

async function connect(workspace: string, extraEnv: Record<string, string> = {}): Promise<Session> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: workspace, env: envFor(workspace, extraEnv), stderr: "pipe" });
  let err = "";
  transport.stderr?.on("data", (d: Buffer) => (err += d.toString()));
  const client = new Client({ name: "necrohex-test", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    stderr: () => err,
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
      const body = (r.structuredContent as Record<string, any> | undefined) ?? (JSON.parse(text) as Record<string, any>);
      return { isError: r.isError === true, body };
    },
    close: () => client.close(),
  };
}

function newWorkspace(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "necrohex-mcp-")));
  copyFileSync(FIXTURE, join(dir, "map.wad"));
  return dir;
}

const lightPatch = (level: number) => ({
  schemaVersion: 1,
  name: "test",
  target: { format: "wad", maps: ["MAP01"] },
  operations: [{ id: "light", select: { record: "Sector", where: { lightlevel: { gte: 192 } } }, change: { lightlevel: { set: level } } }],
});

describe("MCP Server over stdio（无引擎）", () => {
  let ws: string;
  let s: Session;
  beforeAll(async () => {
    ws = newWorkspace();
    s = await connect(ws);
  }, 60_000);
  afterAll(async () => {
    await s?.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("工具列表恰好是五个，没有接受偏移、字节或命令的参数", T, async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["apply_patch", "inspect_wad", "plan_patch", "query_entities", "verify_output"]);
    for (const t of tools) {
      const keys = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      for (const k of keys) expect(k).not.toMatch(/offset|bytes|command|exec|shell|span/i);
    }
  });

  it("inspect_wad 和 query_entities 读出 MAP01、MAP02 和出生点", T, async () => {
    const i = await s.call("inspect_wad", { path: "map.wad" });
    expect(i.isError).toBe(false);
    expect(i.body.maps.map((m: { name: string }) => m.name)).toEqual(["MAP01", "MAP02"]);
    const q = await s.call("query_entities", { path: "map.wad", maps: ["MAP01"], select: { record: "Thing", where: { type: { eq: 1 } } } });
    expect(q.body).toMatchObject({ status: "ok", total: 1 });
    expect(q.body.records[0].fields.type).toBe(1);
  });

  it("plan_patch 不写文件：输入哈希和工作区文件列表不变；返回 Diff 和 planId", T, async () => {
    const before = sha(join(ws, "map.wad"));
    const files = readdirSync(ws).sort();
    const r = await s.call("plan_patch", { inputPath: "map.wad", patch: lightPatch(100) });
    expect(r.isError).toBe(false);
    expect(r.body.status).toBe("ready");
    expect(r.body.planId).toMatch(/^plan-[0-9a-f]{64}$/);
    expect(r.body.inputHash).toBe(`sha256:${before}`);
    expect(r.body.changedCount).toBeGreaterThan(0);
    expect(r.body.diff[0]).toMatchObject({ map: "MAP01", record: "Sector", field: "lightlevel", to: 100 });
    expect(sha(join(ws, "map.wad"))).toBe(before);
    expect(readdirSync(ws).sort()).toEqual(files);
  });

  it("RELOCATED 标为需要核对，给出下标变化和相似度", T, async () => {
    // Freedoom 0.12.1 MAP01 #74 的指纹；夹具是 0.13.0 的 MAP01，对应 #196
    const fingerprint = { tag: 0, floorpic: "AQF026", ceilingpic: "AQF075", heights: [16, 160], centroid: [1798, -723], bbox: [1728, -792, 1872, -640], area: 14192, lineCount: 16 };
    const patch = { schemaVersion: 1, name: "pin", target: { format: "wad", maps: ["MAP01"] }, operations: [{ id: "p", select: { record: "Sector", pin: { map: "MAP01", expectedIndex: 74, fingerprint } }, change: { lightlevel: { set: 100 } } }] };
    const r = await s.call("plan_patch", { inputPath: "map.wad", patch });
    expect(r.body.pins[0]).toMatchObject({ result: "RELOCATED", expectedIndex: 74, index: 196, score: 0.8728, needsReview: true });
    expect(r.body.pins[0].label).toContain("已重定位，请核对");
    expect(r.body.pins[0].label).toContain("#74 → #196");
    expect(r.body.relocatedNeedReview).toEqual(["p: MAP01 #74 → #196 (score 0.8728)"]);
  });

  it("没有 planId、伪造的 planId、补丁或输入变了之后的 planId，apply_patch 都拒绝且不写文件", T, async () => {
    const files = () => readdirSync(ws).sort();
    const before = files();
    const none = await s.call("apply_patch", { inputPath: "map.wad", patch: lightPatch(100), outputPath: "a.wad" });
    expect(none).toMatchObject({ isError: true, body: { error: { code: "PLAN_REQUIRED" } } });
    const fake = await s.call("apply_patch", { inputPath: "map.wad", patch: lightPatch(100), outputPath: "a.wad", planId: "plan-" + "0".repeat(64) });
    expect(fake).toMatchObject({ isError: true, body: { error: { code: "PLAN_UNKNOWN" } } });

    const { body } = await s.call("plan_patch", { inputPath: "map.wad", patch: lightPatch(100) });
    const changedPatch = await s.call("apply_patch", { inputPath: "map.wad", patch: lightPatch(101), outputPath: "a.wad", planId: body.planId });
    expect(changedPatch).toMatchObject({ isError: true, body: { error: { code: "PLAN_MISMATCH" } } });

    copyFileSync(join(ws, "map.wad"), join(ws, "copy.wad"));
    const p2 = await s.call("plan_patch", { inputPath: "copy.wad", patch: lightPatch(100) });
    const bytes = readFileSync(join(ws, "copy.wad"));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff; // 计划之后输入变了
    writeFileSync(join(ws, "copy.wad"), bytes);
    const changedInput = await s.call("apply_patch", { inputPath: "copy.wad", patch: lightPatch(100), outputPath: "a.wad", planId: p2.body.planId });
    expect(changedInput).toMatchObject({ isError: true, body: { error: { code: "PLAN_MISMATCH" } } });
    rmSync(join(ws, "copy.wad"));
    expect(files()).toEqual(before);
  });

  it("不覆盖已有文件（包括输入本身）；工作区外路径、.. 和符号链接出界都被拒绝", T, async () => {
    writeFileSync(join(ws, "taken.wad"), "keep me");
    const { body } = await s.call("plan_patch", { inputPath: "map.wad", patch: lightPatch(100) });
    for (const out of ["taken.wad", "map.wad"]) {
      const r = await s.call("apply_patch", { inputPath: "map.wad", patch: lightPatch(100), outputPath: out, planId: body.planId });
      expect(r).toMatchObject({ isError: true, body: { error: { code: "OUTPUT_EXISTS" } } });
    }
    const receiptTaken = await s.call("apply_patch", { inputPath: "map.wad", patch: lightPatch(100), outputPath: "new.wad", receiptPath: "taken.wad", planId: body.planId });
    expect(receiptTaken).toMatchObject({ isError: true, body: { error: { code: "OUTPUT_EXISTS" } } });
    expect(existsSync(join(ws, "new.wad"))).toBe(false);
    expect(readFileSync(join(ws, "taken.wad"), "utf8")).toBe("keep me");

    const outside = await s.call("inspect_wad", { path: FIXTURE });
    expect(outside).toMatchObject({ isError: true, body: { error: { code: "PATH_OUTSIDE_WORKSPACE" } } });
    const dotdot = await s.call("inspect_wad", { path: "../map.wad" });
    expect(dotdot).toMatchObject({ isError: true, body: { error: { code: "PATH_TRAVERSAL" } } });
    const inner = await s.call("inspect_wad", { path: "sub/../map.wad" });
    expect(inner).toMatchObject({ isError: true, body: { error: { code: "PATH_TRAVERSAL" } } });
    const outOut = await s.call("apply_patch", { inputPath: "map.wad", patch: lightPatch(100), outputPath: join(tmpdir(), "necrohex-escape.wad"), planId: body.planId });
    expect(outOut).toMatchObject({ isError: true, body: { error: { code: "PATH_OUTSIDE_WORKSPACE" } } });

    // 目录联接（Windows 不需要管理员权限）指向工作区之外：解析后出界
    const outsideDir = mkdtempSync(join(tmpdir(), "necrohex-outside-"));
    copyFileSync(FIXTURE, join(outsideDir, "x.wad"));
    try {
      symlinkSync(outsideDir, join(ws, "link"), "junction");
      const viaLink = await s.call("inspect_wad", { path: "link/x.wad" });
      expect(viaLink).toMatchObject({ isError: true, body: { error: { code: "PATH_OUTSIDE_WORKSPACE" } } });
      const writeViaLink = await s.call("apply_patch", { inputPath: "map.wad", patch: lightPatch(100), outputPath: "link/y.wad", planId: body.planId });
      expect(writeViaLink).toMatchObject({ isError: true, body: { error: { code: "PATH_OUTSIDE_WORKSPACE" } } });
      expect(existsSync(join(outsideDir, "y.wad"))).toBe(false);
    } finally {
      rmSync(join(ws, "link"), { recursive: false, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
      rmSync(join(ws, "taken.wad"), { force: true });
    }
  });

  it("Windows 设备名、附加数据流、以点或空格结尾的名字：输出和输入都返回 INVALID_PATH，不写任何东西，planId 仍然可用", T, async () => {
    mkdirSync(join(ws, "out"), { recursive: true });
    const listing = () => {
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name + "/", ...walk(join(d, e.name)).map((x) => `${e.name}/${x}`)] : [e.name]));
      return walk(ws).sort();
    };
    const before = listing();
    const inputHash = sha(join(ws, "map.wad"));
    const { body: p } = await s.call("plan_patch", { inputPath: "map.wad", patch: lightPatch(100) });
    const BAD = ["NUL", "nul.wad", "map.wad:hidden", "out/s.wad:zone", "CON", "con.receipt.json", "COM1.wad", "LPT9", "CONIN$", "conout$.wad", "aux .wad", "trail.", "trail ", "dir./x.wad", "out/NUL/x.wad", "C:relative.wad"];
    for (const name of BAD) {
      for (const field of ["outputPath", "receiptPath", "fullOutputPath"] as const) {
        const args: Record<string, unknown> = { inputPath: "map.wad", patch: lightPatch(100), outputPath: "fresh.wad", planId: p.planId, [field]: name };
        const r = await s.call("apply_patch", args);
        expect(r, `${field} = ${name}`).toMatchObject({ isError: true, body: { error: { code: "INVALID_PATH" } } });
      }
    }
    for (const name of ["map.wad:hidden", "NUL", "map.wad.", "map.wad ", "out/../map.wad"]) {
      const r = await s.call("inspect_wad", { path: name });
      expect(r.isError, name).toBe(true);
      expect(["INVALID_PATH", "PATH_TRAVERSAL"]).toContain(r.body.error.code);
    }
    expect(listing()).toEqual(before);
    expect(sha(join(ws, "map.wad"))).toBe(inputHash);
    if (process.platform === "win32") {
      // 附加数据流不会出现在目录列表里，单独检查
      expect(existsSync(join(ws, "map.wad:hidden"))).toBe(false);
      expect(existsSync(join(ws, "out", "s.wad"))).toBe(false);
    }
    // 被拒绝的调用没有用掉 planId
    const ok = await s.call("apply_patch", { inputPath: "map.wad", patch: lightPatch(100), outputPath: "out/ok.wad", planId: p.planId });
    expect(ok.body.status).toBe("applied");
  });

  it("非法补丁、坏 JSON、坏 WAD、错误的参数类型返回结构化错误，服务器继续可用", T, async () => {
    const invalid = await s.call("plan_patch", { inputPath: "map.wad", patch: { schemaVersion: 1, name: "x", target: { format: "wad", maps: "*" }, operations: [{ id: "o", select: { record: "Sector", offset: 4 }, change: { bytes: { set: 1 } } }] } });
    expect(invalid.isError).toBe(false);
    expect(invalid.body.status).toBe("rejected");
    expect(invalid.body.planId).toBeNull();
    expect(invalid.body.issues.length).toBeGreaterThan(0);
    expect(invalid.body.issues.every((i: { code: string }) => i.code === "INVALID_PATCH")).toBe(true);

    writeFileSync(join(ws, "bad.json"), "{ not json");
    const badJson = await s.call("plan_patch", { inputPath: "map.wad", patchPath: "bad.json" });
    expect(badJson).toMatchObject({ isError: true, body: { error: { code: "INVALID_JSON" } } });
    writeFileSync(join(ws, "bad.wad"), "XWAD this is not a wad");
    const badWad = await s.call("inspect_wad", { path: "bad.wad" });
    expect(badWad).toMatchObject({ isError: true, body: { error: { code: "INVALID_WAD" } } });
    const both = await s.call("plan_patch", { inputPath: "map.wad", patch: lightPatch(1), patchPath: "bad.json" });
    expect(both).toMatchObject({ isError: true, body: { error: { code: "INVALID_ARGUMENT" } } });
    const wrongType = await s.client.callTool({ name: "inspect_wad", arguments: { path: 42 } });
    expect(wrongType.isError).toBe(true);
    const missing = await s.call("inspect_wad", { path: "nope.wad" });
    expect(missing).toMatchObject({ isError: true, body: { error: { code: "FILE_NOT_FOUND" } } });

    const still = await s.call("inspect_wad", { path: "map.wad" });
    expect(still.isError).toBe(false);
    expect(s.stderr()).not.toContain("uncaught");
  });

  it("apply_patch 写出 PWAD 和回执；没有引擎时 verify_output 为 incomplete，不报告通过；CLI revert 还原字节；planId 只能用一次", T, async () => {
    const input = join(ws, "map.wad");
    const inputHash = sha(input);
    const { body: p } = await s.call("plan_patch", { inputPath: "map.wad", patch: lightPatch(100) });
    const a = await s.call("apply_patch", { inputPath: "map.wad", patch: lightPatch(100), outputPath: "out.wad", fullOutputPath: "out-full.wad", planId: p.planId });
    expect(a.isError).toBe(false);
    expect(a.body).toMatchObject({ status: "applied", outputPath: "out.wad", receiptPath: "out.receipt.json", fullOutputPath: "out-full.wad" });
    expect(sha(input)).toBe(inputHash);
    expect(readFileSync(join(ws, "out.wad")).subarray(0, 4).toString()).toBe("PWAD");

    const again = await s.call("apply_patch", { inputPath: "map.wad", patch: lightPatch(100), outputPath: "out2.wad", planId: p.planId });
    expect(again).toMatchObject({ isError: true, body: { error: { code: "PLAN_UNKNOWN" } } });

    const v = await s.call("verify_output", { inputPath: "map.wad", outputPath: "out.wad", receiptPath: "out.receipt.json", fullOutputPath: "out-full.wad" });
    expect(v.isError).toBe(false);
    expect(v.body.status).toBe("incomplete");
    expect(v.body.verified).toBe(false);
    expect(v.body.engine.status).toBe("not_run");
    expect(v.body.engine.reason).toContain("引擎未运行");
    expect(v.body.checks.filter((c: { status: string }) => c.status !== "passed")).toEqual([]);
    expect(JSON.stringify(v.body)).not.toMatch(/guarantee|playable|保证|可玩/i);

    const r = spawnSync(process.execPath, [CLI, "revert", "out-full.wad", "out.receipt.json", "reverted.wad", "--json"], { cwd: ws, env: envFor(ws), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "reverted", matchesReceiptInput: true });
    expect(sha(join(ws, "reverted.wad"))).toBe(inputHash);
  });

  it("verify_output 发现被改过的 PWAD", T, async () => {
    const { body: p } = await s.call("plan_patch", { inputPath: "map.wad", patch: lightPatch(90) });
    await s.call("apply_patch", { inputPath: "map.wad", patch: lightPatch(90), outputPath: "t.wad", planId: p.planId });
    const b = readFileSync(join(ws, "t.wad"));
    b[200] = b[200]! ^ 0x01;
    writeFileSync(join(ws, "t.wad"), b);
    const v = await s.call("verify_output", { inputPath: "map.wad", outputPath: "t.wad", receiptPath: "t.receipt.json" });
    expect(v.body.status).toBe("failed");
    expect(v.body.checks.find((c: { name: string }) => c.name === "pwad-maps").status).toBe("failed");
  });
});

const engine = process.env["NECROHEX_ENGINE"];
const haveEngine = engine !== undefined && engine !== "" && existsSync(engine) && existsSync(CACHE_IWAD);

describe.skipIf(!haveEngine)("MCP Server over stdio（配置了 NECROHEX_ENGINE）", () => {
  it("verify_output 跑引擎冒烟测试，引擎通过且不变量通过时为 passed", T, async () => {
    const ws = newWorkspace();
    mkdirSync(join(ws, "iwad"));
    copyFileSync(CACHE_IWAD, join(ws, "iwad", "freedoom2.wad"));
    const s = await connect(ws, { NECROHEX_ENGINE: engine! });
    try {
      const { body: p } = await s.call("plan_patch", { inputPath: "map.wad", patch: lightPatch(100) });
      await s.call("apply_patch", { inputPath: "map.wad", patch: lightPatch(100), outputPath: "out.wad", planId: p.planId });
      const v = await s.call("verify_output", { inputPath: "map.wad", outputPath: "out.wad", receiptPath: "out.receipt.json", iwadPath: "iwad/freedoom2.wad" });
      expect(v.body.engine.status).toBe("passed");
      expect(v.body.engine.runs).toEqual([expect.objectContaining({ map: "MAP01", ok: true })]);
      expect(v.body.status).toBe("passed");
      expect(v.body.note).toContain("do not show that the map can be finished");
    } finally {
      await s.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
