/**
 * 引擎冒烟测试（仅 Node）：用外部的 DSDA-Doom 载入 PWAD，按无输入的演示录像在目标地图上运行若干 tic。
 * 引擎是 GPL 程序，只作为独立进程调用，不随仓库分发；路径由调用方提供。
 * 通过只说明：引擎载入了这个 PWAD，进入了目标地图，跑完了这些 tic 且正常退出。它不证明地图可以通关。
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildIdleDemo } from "../demo.ts";

export interface EngineSmokeOptions {
  /** DSDA-Doom 可执行文件。 */
  readonly engine: string;
  /** 基础 IWAD，例如 freedoom2.wad。 */
  readonly iwad: string;
  /** 要测试的 PWAD。 */
  readonly pwad: string;
  /** 目标地图，ExMy 或 MAPxx。 */
  readonly map: string;
  /** 默认 350（10 秒游戏时间）。 */
  readonly tics?: number;
  /** 默认 60 秒。超时后结束引擎进程并判为失败。 */
  readonly timeoutMs?: number;
}

export interface EngineSmokeResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  /** 引擎报告的已运行 tic 数；没有报告时为 null。 */
  readonly gametics: number | null;
  /** 通过的检查，按顺序。 */
  readonly passed: readonly string[];
  /** 第一个未通过的检查；通过时为 undefined。 */
  readonly failure?: string;
  /** 引擎的 stdout 与 stderr。 */
  readonly output: string;
  /** 实际运行的命令行参数（不含可执行文件）。 */
  readonly args: readonly string[];
}

/** 引擎的命令行参数。不画面、不出声、不弹对话框，配置和存档写到 workDir。 */
export function engineSmokeArgs(o: { iwad: string; pwad: string; demo: string; workDir: string }): string[] {
  return [
    "-iwad", o.iwad,
    "-file", o.pwad,
    "-timedemo", o.demo,
    "-nodraw", "-nosound", "-nomusic", "-no_message_box", "-noautoload",
    "-config", join(o.workDir, "engine.cfg"),
    "-save", o.workDir,
    "-data", o.workDir,
  ];
}

export async function runEngineSmoke(options: EngineSmokeOptions): Promise<EngineSmokeResult> {
  const tics = options.tics ?? 350;
  const demoBytes = buildIdleDemo({ map: options.map, tics });
  const workDir = await mkdtemp(join(tmpdir(), "necrohex-smoke-"));
  try {
    const demo = join(workDir, "smoke.lmp");
    await writeFile(demo, demoBytes);
    const pwad = resolve(options.pwad);
    const args = engineSmokeArgs({ iwad: resolve(options.iwad), pwad, demo, workDir });
    const { exitCode, output, timedOut } = await run(options.engine, args, workDir, options.timeoutMs ?? 60_000);
    const timed = /Timed (\d+) gametics/.exec(output);
    const gametics = timed ? Number(timed[1]) : null;
    const loaded = output
      .split(/\r?\n/)
      .some((line) => /^\s*adding\s/i.test(line) && basename(line.trim().replace(/^adding\s+/i, "")).toLowerCase() === basename(pwad).toLowerCase());

    const checks: Array<[string, boolean]> = [
      [`engine finished within ${options.timeoutMs ?? 60_000} ms`, !timedOut],
      [`engine loaded ${basename(pwad)}`, loaded],
      [`engine ran ${tics} tics on ${options.map.toUpperCase()}`, gametics === tics],
      ["engine exited with code 0", exitCode === 0],
    ];
    const passed: string[] = [];
    let failure: string | undefined;
    for (const [what, ok] of checks) {
      if (!ok) {
        failure = what;
        break;
      }
      passed.push(what);
    }
    return { ok: failure === undefined, exitCode, gametics, passed, ...(failure ? { failure } : {}), output, args };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function run(cmd: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (output += d.toString("latin1")));
    child.stderr.on("data", (d: Buffer) => (output += d.toString("latin1")));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ exitCode: code, output, timedOut });
    });
  });
}
