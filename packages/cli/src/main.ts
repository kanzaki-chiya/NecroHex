#!/usr/bin/env node
/** necrohex 命令行入口。见 cli.ts。 */
import { runCli } from "./cli.ts";

const code = await runCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
});
process.exitCode = code;
