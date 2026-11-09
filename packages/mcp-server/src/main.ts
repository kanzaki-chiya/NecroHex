#!/usr/bin/env node
/** NecroHex MCP Server 的 stdio 入口。stdout 只给 MCP 协议，日志写 stderr。 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

const log = (msg: string) => process.stderr.write(`[necrohex-mcp] ${msg}\n`);
// 任何漏掉的异常只记录，不让进程退出
process.on("uncaughtException", (e) => log(`uncaught exception: ${e.stack ?? e.message}`));
process.on("unhandledRejection", (e) => log(`unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));

const { server, workspace } = createServer();
await server.connect(new StdioServerTransport());
log(`ready; workspace ${workspace.root}; engine ${process.env["NECROHEX_ENGINE"] ? "configured" : "not configured (verify_output will report the engine as not run)"}`);
