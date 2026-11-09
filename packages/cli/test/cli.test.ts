/**
 * necrohex 命令行：作为子进程运行 src/main.ts，在临时工作区里核对退出码、--json 输出和不覆盖文件。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../../..");
const FIXTURE = join(REPO, "packages/adapter-wad/fixtures/freedoom/freedoom2-map01-02.wad");
const CLI = join(REPO, "packages/cli/src/main.ts");
const T = { timeout: 60_000 };
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

let ws: string;
/** 当作没有安装引擎的 %LOCALAPPDATA%，默认位置也找不到引擎。 */
let noEngine: string;
function cli(...args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "NECROHEX_ENGINE") env[k] = v;
  env["NECROHEX_WORKSPACE"] = ws;
  env["LOCALAPPDATA"] = noEngine;
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ws, env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) as Record<string, any> };
}

const patch = (level: number) => ({
  schemaVersion: 1,
  name: "cli test",
  target: { format: "wad", maps: ["MAP01"] },
  operations: [{ id: "light", select: { record: "Sector", where: { lightlevel: { gte: 192 } } }, change: { lightlevel: { set: level } } }],
});

beforeAll(() => {
  ws = realpathSync.native(mkdtempSync(join(tmpdir(), "necrohex-cli-")));
  noEngine = realpathSync.native(mkdtempSync(join(tmpdir(), "necrohex-noengine-")));
  copyFileSync(FIXTURE, join(ws, "map.wad"));
  writeFileSync(join(ws, "p.json"), JSON.stringify(patch(100)));
  writeFileSync(join(ws, "bad.json"), JSON.stringify({ schemaVersion: 1, name: "x", target: { format: "wad", maps: "*" }, operations: [] }));
});
afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(noEngine, { recursive: true, force: true });
});

describe("necrohex CLI", () => {
  it("用法错误退出码为 2", T, () => {
    expect(cli().code).toBe(0); // 没有参数时打印用法
    expect(cli("explode").code).toBe(2);
    expect(cli("inspect").code).toBe(2);
    expect(cli("inspect", "map.wad", "--nope").code).toBe(2);
    expect(cli("inspect", "../map.wad", "--json")).toMatchObject({ code: 2 });
    expect(cli("inspect", "../map.wad", "--json").json()).toEqual({ error: { code: "PATH_TRAVERSAL", message: expect.any(String) } });
    expect(cli("inspect", FIXTURE, "--json").json().error.code).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("inspect 和 query 成功时退出码为 0", T, () => {
    const i = cli("inspect", "map.wad", "--json");
    expect(i.code).toBe(0);
    expect(i.json().maps.map((m: { name: string }) => m.name)).toEqual(["MAP01", "MAP02"]);
    const q = cli("query", "map.wad", "--select", JSON.stringify({ record: "Sector", pin: { map: "MAP01", expectedIndex: 0 } }), "--fingerprint", "--json");
    expect(q.code).toBe(0);
    expect(q.json().records[0].fingerprint.floorpic).toBe("SLIME14");
  });

  it("plan 不写文件；被拒绝的补丁退出码为 1", T, () => {
    const before = sha(join(ws, "map.wad"));
    const ok = cli("plan", "map.wad", "p.json", "--json");
    expect(ok.code).toBe(0);
    expect(ok.json()).toMatchObject({ status: "ready", planId: expect.stringMatching(/^plan-/) });
    const bad = cli("plan", "map.wad", "bad.json", "--json");
    expect(bad.code).toBe(1);
    expect(bad.json()).toMatchObject({ status: "rejected", planId: null });
    expect(sha(join(ws, "map.wad"))).toBe(before);
  });

  it("apply 用 plan 的 planId；补丁变了 planId 就不匹配；不覆盖已有文件；revert 还原字节；verify 没有引擎时退出码为 1", T, () => {
    const planId = cli("plan", "map.wad", "p.json", "--json").json().planId as string;
    writeFileSync(join(ws, "p2.json"), JSON.stringify(patch(101)));
    const mismatch = cli("apply", "map.wad", "p2.json", "x.wad", "--plan-id", planId, "--json");
    expect(mismatch.code).toBe(1);
    expect(mismatch.json().error.code).toBe("PLAN_MISMATCH");
    expect(existsSync(join(ws, "x.wad"))).toBe(false);

    const a = cli("apply", "map.wad", "p.json", "out.wad", "--full", "full.wad", "--plan-id", planId, "--json");
    expect(a.code).toBe(0);
    expect(a.json().status).toBe("applied");
    const again = cli("apply", "map.wad", "p.json", "out.wad", "--json");
    expect(again.code).toBe(2);
    expect(again.json().error.code).toBe("OUTPUT_EXISTS");

    const v = cli("verify", "map.wad", "out.wad", "out.receipt.json", "--full", "full.wad", "--json");
    expect(v.code).toBe(1);
    expect(v.json()).toMatchObject({ status: "incomplete", verified: false, engine: { status: "not_run" } });
    expect(v.json().engine).toMatchObject({ source: "default", path: join(noEngine, "necrohex", "engines", "dsda-doom-0.30.1", "dsda-doom-0.30.1-win-x64", "dsda-doom.exe") });
    const text = cli("verify", "map.wad", "out.wad", "out.receipt.json");
    expect(text.out).toContain("引擎未运行");
    expect(text.out).toContain("engine path: ");
    const devices = cli("apply", "map.wad", "p.json", "NUL", "--json");
    expect(devices.code).toBe(2);
    expect(devices.json().error.code).toBe("INVALID_PATH");

    const r = cli("revert", "full.wad", "out.receipt.json", "back.wad", "--json");
    expect(r.code).toBe(0);
    expect(sha(join(ws, "back.wad"))).toBe(sha(join(ws, "map.wad")));
    const wrong = cli("revert", "map.wad", "out.receipt.json", "back2.wad", "--json");
    expect(wrong.code).toBe(1);
    expect(wrong.json().status).toBe("rejected");
  });
});
