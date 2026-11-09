#!/usr/bin/env node
/** NecroHex MCP Server 的 stdio 入口。stdout 只给 MCP 协议，日志写 stderr。 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findEngine } from "@necrohex/cli/ops";
import { createServer } from "./server.ts";

const log = (msg: string) => process.stderr.write(`[necrohex-mcp] ${msg}\n`);
// 任何漏掉的异常只记录，不让进程退出
process.on("uncaughtException", (e) => log(`uncaught exception: ${e.stack ?? e.message}`));
process.on("unhandledRejection", (e) => log(`unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));

const { server, workspace, workspaceSource } = createServer();
await server.connect(new StdioServerTransport());
const engine = findEngine();
log(`ready; workspace ${workspace.root} (from ${workspaceSource}); engine ${engine.path ?? "none"} (from ${engine.source}; checked when verify_output runs)`);
