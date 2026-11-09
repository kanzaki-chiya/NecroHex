/**
 * CLI 和 MCP 共用的结构化错误。code 是稳定的机器可读代码，message 给人看。
 * 补丁被拒绝不是错误：plan 和 apply 照常返回结果，status 为 rejected，issues 列出原因。
 */
export type ToolErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_PATH"
  | "PATH_TRAVERSAL"
  | "PATH_OUTSIDE_WORKSPACE"
  | "WORKSPACE_NOT_FOUND"
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "OUTPUT_EXISTS"
  | "INVALID_JSON"
  | "INVALID_WAD"
  | "PLAN_REQUIRED"
  | "PLAN_UNKNOWN"
  | "PLAN_MISMATCH"
  | "PLAN_REJECTED"
  | "NOTHING_TO_WRITE"
  | "EXPORT_REJECTED"
  | "WRITE_FAILED"
  | "INTERNAL";

/** 调用方的用法问题（参数、路径、已存在的输出），CLI 用退出码 2；其他为 1。 */
const USAGE: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  "INVALID_ARGUMENT",
  "INVALID_PATH",
  "PATH_TRAVERSAL",
  "PATH_OUTSIDE_WORKSPACE",
  "WORKSPACE_NOT_FOUND",
  "FILE_NOT_FOUND",
  "NOT_A_FILE",
  "OUTPUT_EXISTS",
  "PLAN_REQUIRED",
]);

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly details: unknown;
  constructor(code: ToolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
  get usage(): boolean {
    return USAGE.has(this.code);
  }
}

/** 任意异常转成结构化错误；未知异常为 INTERNAL，不带堆栈。 */
export function toToolError(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  return new ToolError("INTERNAL", e instanceof Error ? e.message : String(e));
}

export function errorJson(e: ToolError): { error: { code: ToolErrorCode; message: string; details?: unknown } } {
  return { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } };
}
