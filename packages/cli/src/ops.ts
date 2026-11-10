/**
 * CLI 和 MCP Server 共用的操作：inspect、query、plan、apply、revert、verify。
 * 只调用 @necrohex/core 和 @necrohex/adapter-wad 的公开导出，补丁的校验、选择、重定位、写入和撤销全部由引擎完成，这里只做：
 * 文件读写（经 workspace.ts 的路径限制）、planId 绑定、把引擎结果整理成便于阅读的报告。
 * 没有任何按偏移写字节的操作；所有写入都经补丁引擎或 WadFile.setField（按记录和字段）。
 * 报告只写做过哪些检查，不声称地图可以通关。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyPatch,
  bytesHash,
  patchHash,
  planPatch,
  queryRecords,
  revertPatch,
  type CheckResult,
  type FieldValue,
  type PatchIssue,
  type PinResolution,
  type PlannedChange,
  type RecordAdapter,
  type Selection,
} from "@necrohex/core";
import { createWadAdapter, exportPwad, WadExportError, WadFile, WadParseError, wadAdapter, type MapScope } from "@necrohex/adapter-wad";
import { runEngineSmoke } from "./engine-smoke.ts";
import { ToolError } from "./errors.ts";
import { display, inputPath, outputPath, type Workspace } from "./workspace.ts";

export const STATIC_ONLY = "These are static checks. They report what was checked; they do not show that the map can be finished.";

// ---------------------------------------------------------------------------
// 读取

interface LoadedWad {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly wad: WadFile;
  readonly hash: string;
}

function loadWad(ws: Workspace, p: unknown, what: string): LoadedWad {
  const path = inputPath(ws, p, what);
  const bytes = new Uint8Array(readFileSync(path));
  let wad: WadFile;
  try {
    wad = WadFile.parse(bytes);
  } catch (e) {
    if (e instanceof WadParseError) throw new ToolError("INVALID_WAD", `${what} ${display(ws, path)} is not a readable WAD: ${e.message}`, { reason: e.code });
    throw e;
  }
  return { path, bytes, wad, hash: bytesHash(bytes) };
}

function loadJson(ws: Workspace, p: unknown, what: string): { path: string; value: unknown } {
  const path = inputPath(ws, p, what);
  const text = readFileSync(path, "utf8");
  try {
    return { path, value: JSON.parse(text) as unknown };
  } catch (e) {
    throw new ToolError("INVALID_JSON", `${what} ${display(ws, path)} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface PatchSource {
  /** 补丁对象（与 patchPath 二选一）。 */
  readonly patch?: unknown;
  /** 补丁文件（与 patch 二选一）。 */
  readonly patchPath?: string | undefined;
}

function loadPatch(ws: Workspace, s: PatchSource): { patch: unknown; source: string } {
  const hasInline = s.patch !== undefined;
  const hasPath = s.patchPath !== undefined;
  if (hasInline === hasPath) throw new ToolError("INVALID_ARGUMENT", "give exactly one of patch (a JSON object) or patchPath (a .nhpatch.json file)");
  if (hasInline) return { patch: s.patch, source: "inline" };
  const j = loadJson(ws, s.patchPath, "patchPath");
  return { patch: j.value, source: display(ws, j.path) };
}

function adapterFor(iwad: LoadedWad | undefined): RecordAdapter {
  return iwad ? createWadAdapter({ baseIwad: iwad.bytes }) : wadAdapter;
}

// ---------------------------------------------------------------------------
// inspect

const RECORD_LUMPS: Readonly<Record<string, string>> = { Sector: "SECTORS", Thing: "THINGS", Linedef: "LINEDEFS", Sidedef: "SIDEDEFS", Vertex: "VERTEXES" };

export interface InspectArgs {
  readonly path: string;
  /** 列出全部 Lump（名称、大小）；默认只给数量。 */
  readonly includeLumps?: boolean | undefined;
}

export function inspect(ws: Workspace, args: InspectArgs) {
  const w = loadWad(ws, args.path, "path");
  const source = wadAdapter.open(w.bytes);
  const scopeIds = new Map<number, string>();
  for (const s of source.scopes()) {
    const m = s.id.includes("@") ? w.wad.maps.find((x) => x.markerIndex === Number(s.id.split("@")[1])) : w.wad.findMap(s.id);
    if (m) scopeIds.set(m.markerIndex, s.id);
  }
  const maps = w.wad.maps.map((m) => {
    const scope = scopeIds.get(m.markerIndex);
    const records: Record<string, number> | null = scope === undefined ? null : {};
    if (scope !== undefined) for (const r of Object.keys(source.schema)) records![r] = source.recordCount(scope, r);
    return {
      name: m.name,
      scope: scope ?? null,
      format: m.format,
      lumps: m.dataIndices.map((i) => w.wad.lumps[i]!.name),
      records,
      ...(scope === undefined ? { note: `${m.format} maps are recognized but not parsed; their records cannot be queried or patched` } : {}),
    };
  });
  return {
    path: display(ws, w.path),
    sha256: w.hash,
    size: w.bytes.length,
    kind: w.wad.kind,
    lumpCount: w.wad.lumps.length,
    mapCount: maps.length,
    maps,
    recordTypes: Object.fromEntries(Object.entries(source.schema).map(([r, s]) => [r, { writable: s.writable, lump: RECORD_LUMPS[r] ?? null, fields: s.fields }])),
    ...(args.includeLumps ? { lumps: w.wad.lumps.map((l) => ({ index: l.index, name: l.name, size: l.size })) } : {}),
  };
}

// ---------------------------------------------------------------------------
// 结果整理

/** pin 结果的阅读视图。RELOCATED 明确标为需要核对，不说成已确认正确。 */
export function pinView(p: PinResolution) {
  let label: string;
  if (p.result === "EXACT") {
    label = p.fingerprintChecked
      ? `EXACT: #${p.index} matches its fingerprint (score ${p.score})`
      : `EXACT: #${p.index} selected by index only; no fingerprint was given, so nothing was verified`;
  } else if (p.result === "RELOCATED") {
    label = `已重定位，请核对 (RELOCATED, please review): #${p.expectedIndex} → #${p.index}, score ${p.score}. It is the only candidate above the high-confidence threshold; this does not confirm it is the right record`;
  } else if (p.result === "CONFLICT_AMBIGUOUS") {
    label = `refused (CONFLICT_AMBIGUOUS): ${p.message}`;
  } else {
    label = `refused (CONFLICT_MISSING): ${p.message}`;
  }
  return {
    operationId: p.operationId,
    map: p.map,
    record: p.record,
    result: p.result,
    expectedIndex: p.expectedIndex,
    index: p.index ?? null,
    score: p.score ?? null,
    fingerprintChecked: p.fingerprintChecked,
    needsReview: p.result === "RELOCATED",
    candidates: p.candidates,
    candidateCount: p.candidateCount,
    label,
  };
}

function selectionView(s: Selection) {
  if (s.kind === "WHERE" || s.kind === "ALL") return { kind: s.kind };
  return { kind: s.kind, expectedIndex: s.expectedIndex, fingerprintChecked: s.fingerprintChecked, ...("score" in s ? { score: s.score } : {}) };
}

function issueView(i: PatchIssue) {
  return {
    code: i.code,
    message: i.message,
    ...(i.path !== undefined ? { path: i.path } : {}),
    ...(i.operationId !== undefined ? { operationId: i.operationId } : {}),
    ...(i.reason !== undefined ? { reason: i.reason } : {}),
    ...(i.hook !== undefined ? { hook: i.hook } : {}),
    ...(i.locator !== undefined ? { locator: i.locator } : {}),
    ...(i.field !== undefined ? { field: i.field } : {}),
    ...(i.candidates !== undefined ? { candidates: i.candidates } : {}),
  };
}

const checkView = (c: CheckResult) => ({ name: c.name, kind: c.kind, status: c.status, description: c.description });

// ---------------------------------------------------------------------------
// query

export interface QueryArgs {
  readonly path: string;
  /** 补丁里的选择器：{ record, where | pin | all }。 */
  readonly select: unknown;
  /** 地图名，默认全部。 */
  readonly maps?: "*" | string[] | undefined;
  /** 只返回这些字段；默认返回全部可读的整数和名称字段。 */
  readonly fields?: string[] | undefined;
  /** 最多返回多少条，默认 100，上限 1000。 */
  readonly limit?: number | undefined;
  /** 附上扇区的语义指纹（只有 Sector 支持），可直接写进 pin。 */
  readonly includeFingerprint?: boolean | undefined;
}

export function query(ws: Workspace, args: QueryArgs) {
  const w = loadWad(ws, args.path, "path");
  const limit = args.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ToolError("INVALID_ARGUMENT", "limit must be an integer from 1 to 1000");
  const q = queryRecords(w.bytes, { maps: args.maps ?? "*", select: args.select }, wadAdapter);
  const source = wadAdapter.open(w.bytes);
  const record = (args.select as { record?: unknown } | null)?.record;
  const schema = typeof record === "string" && Object.hasOwn(source.schema, record) ? source.schema[record]! : undefined;
  const readable = schema ? Object.entries(schema.fields).filter(([, k]) => k !== "other").map(([f]) => f) : [];
  const fields = args.fields ?? readable;
  const unknown = fields.filter((f) => !readable.includes(f));
  if (q.ok && unknown.length > 0) throw new ToolError("INVALID_ARGUMENT", `unknown or unreadable field(s) for ${String(record)}: ${unknown.join(", ")}; readable: ${readable.join(", ")}`);
  const wantFp = args.includeFingerprint === true;
  if (wantFp && record !== "Sector") throw new ToolError("INVALID_ARGUMENT", "includeFingerprint is only supported for Sector");
  const records = q.records.slice(0, limit).map((r) => ({
    map: r.locator.scope,
    record: r.locator.record,
    index: r.locator.index,
    fields: Object.fromEntries(fields.map((f): [string, FieldValue] => [f, source.readField(r.locator, f)])),
    ...(wantFp ? { fingerprint: source.fingerprints!.compute(r.locator) } : {}),
  }));
  return {
    path: display(ws, w.path),
    sha256: w.hash,
    status: q.ok ? "ok" : "rejected",
    total: q.records.length,
    returned: records.length,
    truncated: q.records.length > records.length,
    records,
    pins: q.pins.map(pinView),
    issues: q.issues.map(issueView),
  };
}

// ---------------------------------------------------------------------------
// plan

export interface PlanArgs extends PatchSource {
  readonly inputPath: string;
  /** 基础 IWAD：新贴图名在其中查找；verify 的引擎冒烟测试也用它。 */
  readonly iwadPath?: string | undefined;
  /** 最多列出多少条字段 Diff，默认 200。 */
  readonly diffLimit?: number | undefined;
}

/** planId 绑定补丁哈希、输入哈希和基础 IWAD 哈希；任何一个变了，planId 就对不上。 */
export function planBinding(patchHashValue: string, inputHash: string, iwadHash: string | null): string {
  return "plan-" + createHash("sha256").update(`necrohex-plan-v1\n${patchHashValue}\n${inputHash}\n${iwadHash ?? "-"}`).digest("hex");
}

function planCore(ws: Workspace, args: PlanArgs) {
  const input = loadWad(ws, args.inputPath, "inputPath");
  const iwad = args.iwadPath === undefined ? undefined : loadWad(ws, args.iwadPath, "iwadPath");
  const { patch, source } = loadPatch(ws, args);
  const adapter = adapterFor(iwad);
  let ph: string | null = null;
  try {
    ph = patchHash(patch);
  } catch {
    ph = null; // 结构不合法，planPatch 会给出具体问题
  }
  return { input, iwad, patch, source, adapter, patchHash: ph, binding: ph === null ? null : planBinding(ph, input.hash, iwad?.hash ?? null) };
}

export function plan(ws: Workspace, args: PlanArgs) {
  const c = planCore(ws, args);
  const r = planPatch(c.input.bytes, c.patch, c.adapter);
  const diffLimit = args.diffLimit ?? 200;
  if (!Number.isSafeInteger(diffLimit) || diffLimit < 0) throw new ToolError("INVALID_ARGUMENT", "diffLimit must be a non-negative integer");
  const ready = r.ok && c.binding !== null;
  return {
    status: ready ? ("ready" as const) : ("rejected" as const),
    planId: ready ? c.binding : null,
    inputPath: display(ws, c.input.path),
    inputHash: c.input.hash,
    iwadPath: c.iwad ? display(ws, c.iwad.path) : null,
    iwadHash: c.iwad?.hash ?? null,
    patchSource: c.source,
    patchHash: c.patchHash,
    matches: r.matches,
    changedCount: r.changedCount,
    diffTotal: r.changes.length,
    diff: r.changes.slice(0, diffLimit).map((ch) => ({
      operationId: ch.operationId,
      map: ch.scope,
      record: ch.record,
      index: ch.index,
      field: ch.field,
      from: ch.oldValue,
      to: ch.newValue,
      unchanged: ch.unchanged,
      selection: selectionView(ch.selection),
    })),
    pins: r.pins.map(pinView),
    relocatedNeedReview: r.pins.filter((p) => p.result === "RELOCATED").map((p) => `${p.operationId}: ${p.map} #${p.expectedIndex} → #${p.index} (score ${p.score})`),
    warnings: r.warnings.map(issueView),
    issues: r.issues.map(issueView),
    checks: r.checks.map(checkView),
    note: ready ? `Nothing was written. Pass planId to apply. ${STATIC_ONLY}` : `Nothing was written. The patch was rejected; see issues. ${STATIC_ONLY}`,
  };
}

// ---------------------------------------------------------------------------
// apply

export interface ApplyArgs extends PlanArgs {
  /** 导出的 PWAD。必须是新文件。 */
  readonly outputPath: string;
  /** 回执，默认 <outputPath 去掉 .wad>.receipt.json。必须是新文件。 */
  readonly receiptPath?: string | undefined;
  /** 另外写出应用后的整份 WAD（撤销和 verify 的 I-4 检查用）。必须是新文件。 */
  readonly fullOutputPath?: string | undefined;
  /** plan 返回的 planId。给出时，补丁、输入或基础 IWAD 与干跑时不同就拒绝。 */
  readonly planId?: string | undefined;
}

function sameFile(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 独占创建；任何一个失败时删掉本次已创建的文件。 */
function writeAll(files: ReadonlyArray<readonly [string, Uint8Array | string]>): void {
  const done: string[] = [];
  try {
    for (const [p, data] of files) {
      writeFileSync(p, data, { flag: "wx" });
      done.push(p);
    }
  } catch (e) {
    for (const p of done) rmSync(p, { force: true });
    const code = (e as { code?: string }).code;
    if (code === "EEXIST") throw new ToolError("OUTPUT_EXISTS", `${(e as { path?: string }).path ?? "an output file"} appeared before it could be written; nothing was kept`);
    throw new ToolError("WRITE_FAILED", `could not write outputs: ${e instanceof Error ? e.message : String(e)}; nothing was kept`);
  }
}

/**
 * 在输入上按记录和字段（WadFile.setField）重放引擎实际改动的条目（跳过 unchanged），得到带脏区间的 WadFile。
 * exportPwad 按脏区间标记每张地图的 modified，并检查改动都落在导出的 Lump 内；重新解析引擎输出得到的 WadFile 没有脏区间。
 * 重放结果必须与引擎输出逐字节相同，否则抛 INTERNAL，不写任何文件。
 */
export function replayChanges(input: Uint8Array, changes: readonly PlannedChange[], expected: Uint8Array): WadFile {
  const wad = WadFile.parse(input);
  for (const e of changes) {
    if (e.unchanged) continue;
    const m = mapOfScope(wad, e.scope);
    const lumpName = WRITABLE_LUMP[e.record];
    const lump = m && lumpName ? m.lumps[lumpName] : undefined;
    if (lump === undefined) throw new ToolError("INTERNAL", `${e.scope} ${e.record} #${e.index} is not a writable record in the input; nothing was written`);
    wad.setField(lump, e.record as "Sector", e.index, e.field as never, e.newValue as never);
  }
  if (!eqBytes(wad.serialize(), expected)) throw new ToolError("INTERNAL", "replaying the patch's changes on the input does not give the engine's output; nothing was written");
  return wad;
}

export function apply(ws: Workspace, args: ApplyArgs) {
  const c = planCore(ws, args);
  const out = outputPath(ws, args.outputPath, "outputPath");
  const receiptRaw = args.receiptPath ?? args.outputPath.replace(/\.wad$/i, "") + ".receipt.json";
  const receiptPath = outputPath(ws, receiptRaw, "receiptPath");
  const full = args.fullOutputPath === undefined ? undefined : outputPath(ws, args.fullOutputPath, "fullOutputPath");
  const outs = [out, receiptPath, ...(full ? [full] : [])];
  for (let i = 0; i < outs.length; i++) for (let j = i + 1; j < outs.length; j++) if (sameFile(outs[i]!, outs[j]!)) throw new ToolError("INVALID_ARGUMENT", "outputPath, receiptPath and fullOutputPath must be different files");

  if (args.planId !== undefined && args.planId !== c.binding) {
    throw new ToolError(
      "PLAN_MISMATCH",
      "planId does not match this patch, input and base IWAD: one of them changed since plan (or the plan was for another file). Run plan again.",
      { expected: c.binding, given: args.planId, patchHash: c.patchHash, inputHash: c.input.hash, iwadHash: c.iwad?.hash ?? null },
    );
  }
  const r = applyPatch(c.input.bytes, c.patch, c.adapter);
  if (!r.ok) {
    return {
      status: "rejected" as const,
      written: [] as string[],
      pins: r.pins.map(pinView),
      issues: r.issues.map(issueView),
      warnings: r.warnings.map(issueView),
      checks: r.checks.map(checkView),
      note: "The patch was rejected; nothing was written.",
    };
  }
  const changedScopes = [...new Set(r.changes.filter((x) => !x.unchanged).map((x) => x.scope))];
  if (changedScopes.length === 0) throw new ToolError("NOTHING_TO_WRITE", "the patch changes no bytes on this input (every new value equals the old one); nothing was written");
  const modified = replayChanges(c.input.bytes, r.changes, r.output!);
  let pwad;
  try {
    pwad = exportPwad(modified, { maps: changedScopes.map((s) => s.split("@")[0]!) });
  } catch (e) {
    if (e instanceof WadExportError) throw new ToolError("EXPORT_REJECTED", `PWAD export refused: ${e.message}; nothing was written`);
    throw e;
  }
  const receiptText = JSON.stringify(r.receipt, null, 2) + "\n";
  writeAll([[out, pwad.bytes], [receiptPath, receiptText], ...(full ? ([[full, r.output!]] as const) : [])]);
  return {
    status: "applied" as const,
    written: outs.map((p) => display(ws, p)),
    outputPath: display(ws, out),
    outputSha256: bytesHash(pwad.bytes),
    receiptPath: display(ws, receiptPath),
    fullOutputPath: full ? display(ws, full) : null,
    inputUnchanged: display(ws, c.input.path),
    receipt: { patchHash: r.receipt!.patchHash, inputHash: r.receipt!.inputHash, outputHash: r.receipt!.outputHash, entries: r.receipt!.entries.length },
    changedCount: r.changedCount,
    maps: pwad.maps,
    exportChecks: pwad.checks,
    pins: r.pins.map(pinView),
    relocatedNeedReview: r.pins.filter((p) => p.result === "RELOCATED").map((p) => `${p.operationId}: ${p.map} #${p.expectedIndex} → #${p.index} (score ${p.score})`),
    warnings: r.warnings.map(issueView),
    checks: r.checks.map(checkView),
    note: `The receipt maps the full input WAD to the full patched WAD, not to the PWAD. Run verify next. ${STATIC_ONLY}`,
  };
}

// ---------------------------------------------------------------------------
// revert

export interface RevertArgs {
  /** 应用后的整份 WAD（apply 的 fullOutputPath）。 */
  readonly inputPath: string;
  readonly receiptPath: string;
  /** 撤销结果。必须是新文件。 */
  readonly outputPath: string;
}

export function revert(ws: Workspace, args: RevertArgs) {
  const w = loadWad(ws, args.inputPath, "inputPath");
  const receipt = loadJson(ws, args.receiptPath, "receiptPath");
  const out = outputPath(ws, args.outputPath, "outputPath");
  const r = revertPatch(w.bytes, receipt.value, wadAdapter);
  if (!r.ok) return { status: "rejected" as const, written: [] as string[], issues: r.issues.map(issueView), note: "The receipt does not apply to this file; nothing was written." };
  writeAll([[out, r.output!]]);
  const expected = (receipt.value as { inputHash?: unknown }).inputHash;
  return {
    status: "reverted" as const,
    written: [display(ws, out)],
    outputPath: display(ws, out),
    outputSha256: bytesHash(r.output!),
    matchesReceiptInput: bytesHash(r.output!) === expected,
  };
}

// ---------------------------------------------------------------------------
// verify

export interface VerifyArgs {
  /** 原始输入（apply 的 inputPath）。 */
  readonly inputPath: string;
  /** apply 导出的 PWAD。 */
  readonly outputPath: string;
  readonly receiptPath: string;
  /** apply 写出的整份 WAD；给出时核对它的哈希。 */
  readonly fullOutputPath?: string | undefined;
  /** 引擎冒烟测试的基础 IWAD。 */
  readonly iwadPath?: string | undefined;
  /** 每张地图运行的 tic 数，默认 350。 */
  readonly tics?: number | undefined;
}

type CheckStatus = "passed" | "failed" | "skipped";
interface VerifyCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

interface ReceiptEntry {
  scope: string;
  record: string;
  index: number;
  field: string;
  oldValue: FieldValue;
  newValue: FieldValue;
  span: { start: number; end: number };
}

function mapOfScope(wad: WadFile, scope: string): MapScope | undefined {
  if (!scope.includes("@")) return wad.findMap(scope);
  const [name, marker] = scope.split("@");
  return wad.maps.find((m) => m.name.toUpperCase() === name!.toUpperCase() && m.markerIndex === Number(marker));
}

const WRITABLE_LUMP: Readonly<Record<string, string>> = { Sector: "SECTORS", Thing: "THINGS" };

/** DSDA-Doom 的默认安装位置，相对 %LOCALAPPDATA%。 */
export const DEFAULT_ENGINE_SUBPATH = ["necrohex", "engines", "dsda-doom-0.30.1", "dsda-doom-0.30.1-win-x64", "dsda-doom.exe"] as const;

export type EngineSource = "NECROHEX_ENGINE" | "default";

/**
 * 要用的引擎路径。NECROHEX_ENGINE 非空时用它（即使文件不存在，也不退回默认位置）；
 * 否则用 %LOCALAPPDATA% 下的默认位置；LOCALAPPDATA 也没有时为 null。只返回路径，存在与否由调用方检查。
 */
export function findEngine(env: NodeJS.ProcessEnv = process.env): { path: string | null; source: EngineSource } {
  const set = env["NECROHEX_ENGINE"];
  if (set !== undefined && set !== "") return { path: set, source: "NECROHEX_ENGINE" };
  const local = env["LOCALAPPDATA"];
  return { path: local === undefined || local === "" ? null : join(local, ...DEFAULT_ENGINE_SUBPATH), source: "default" };
}

const eqBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export async function verify(ws: Workspace, args: VerifyArgs) {
  const input = loadWad(ws, args.inputPath, "inputPath");
  const pwadFile = loadWad(ws, args.outputPath, "outputPath");
  const receipt = loadJson(ws, args.receiptPath, "receiptPath");
  const full = args.fullOutputPath === undefined ? undefined : loadWad(ws, args.fullOutputPath, "fullOutputPath");
  const iwad = args.iwadPath === undefined ? undefined : inputPath(ws, args.iwadPath, "iwadPath");
  const tics = args.tics ?? 350;
  if (!Number.isSafeInteger(tics) || tics < 1 || tics > 35 * 600) throw new ToolError("INVALID_ARGUMENT", "tics must be an integer from 1 to 21000");

  const checks: VerifyCheck[] = [];
  const add = (name: string, ok: boolean | null, detail: string) => checks.push({ name, status: ok === null ? "skipped" : ok ? "passed" : "failed", detail });
  const rv = receipt.value as { inputHash?: unknown; outputHash?: unknown; entries?: unknown };
  const entries = Array.isArray(rv?.entries) ? (rv.entries as ReceiptEntry[]) : null;

  add("receipt-input-hash", rv?.inputHash === input.hash, `receipt.inputHash ${String(rv?.inputHash)}; input ${input.hash}`);

  // 用输入和回执里的新值（按记录和字段，经 WadFile.setField）重建应用后的整份 WAD
  let rebuilt: Uint8Array | undefined;
  let rebuiltWad: WadFile | undefined;
  if (!entries) add("receipt-replay", false, "receipt has no entries array");
  else {
    try {
      const wad = WadFile.parse(input.bytes);
      for (const e of entries) {
        const m = mapOfScope(wad, e.scope);
        const lumpName = WRITABLE_LUMP[e.record];
        if (!m || !lumpName || m.lumps[lumpName] === undefined) throw new Error(`receipt entry ${e.scope} ${e.record} #${e.index} does not name a writable record in the input`);
        const lump = m.lumps[lumpName]!;
        const old = (wad.readRecord(lump, e.record as "Sector", e.index) as unknown as Record<string, unknown>)[e.field];
        if (old !== e.oldValue) throw new Error(`${e.scope} ${e.record} #${e.index} ${e.field} is ${JSON.stringify(old)} in the input, receipt says ${JSON.stringify(e.oldValue)}`);
        const s = wad.fieldSpan(lump, e.record as "Sector", e.index, e.field as never);
        if (s.start !== e.span.start || s.end !== e.span.end) throw new Error(`${e.scope} ${e.record} #${e.index} ${e.field}: receipt span [${e.span.start}, ${e.span.end}) is not the field's span [${s.start}, ${s.end})`);
        wad.setField(lump, e.record as "Sector", e.index, e.field as never, e.newValue as never);
      }
      rebuilt = wad.serialize();
      rebuiltWad = WadFile.parse(rebuilt);
      const h = bytesHash(rebuilt);
      add("receipt-replay", h === rv.outputHash, `input + receipt new values (${entries.length} entries) hash to ${h}; receipt.outputHash ${String(rv.outputHash)}`);
    } catch (e) {
      add("receipt-replay", false, e instanceof Error ? e.message : String(e));
    }
  }

  if (full) add("full-output-hash", full.hash === rv?.outputHash, `fullOutputPath hashes to ${full.hash}; receipt.outputHash ${String(rv?.outputHash)}`);
  else add("full-output-hash", null, "no fullOutputPath given");

  if (rebuilt && entries) {
    // I-3：字节变化只出现在回执记录的区间内
    const inSpan = (i: number) => entries.some((e) => i >= e.span.start && i < e.span.end);
    let stray = -1;
    for (let i = 0; i < rebuilt.length; i++) if (rebuilt[i] !== input.bytes[i] && !inSpan(i)) stray = i;
    add("locality (I-3)", rebuilt.length === input.bytes.length && stray < 0, stray < 0 ? "every changed byte lies inside a receipt span" : `byte ${stray} changed outside every receipt span`);
    // I-4：按回执撤销后与输入逐字节相同
    const back = revertPatch(rebuilt, receipt.value, wadAdapter);
    add("revert (I-4)", back.ok && eqBytes(back.output!, input.bytes), back.ok ? "reverting with the receipt gives back the input byte for byte" : `revert refused: ${back.issues.map((i) => i.message).join("; ")}`);
  } else {
    add("locality (I-3)", null, "skipped: the receipt could not be replayed");
    add("revert (I-4)", null, "skipped: the receipt could not be replayed");
  }

  // PWAD：每张有修改的地图都在，带标记和全部数据 Lump，名称和数据与应用后的整份 WAD 相同；没有别的 Lump
  const pw = pwadFile.wad;
  const pwadMaps = pw.maps.map((m) => m.name);
  if (!rebuiltWad || !entries) add("pwad-maps", null, "skipped: the receipt could not be replayed");
  else {
    const problems: string[] = [];
    if (pw.kind !== "PWAD") problems.push(`outputPath is an ${pw.kind}, not a PWAD`);
    const changed = [...new Set(entries.filter((e) => e.oldValue !== e.newValue).map((e) => e.scope.split("@")[0]!.toUpperCase()))];
    for (const name of changed) if (!pw.findMap(name)) problems.push(`changed map ${name} is missing from the PWAD`);
    const covered = new Set<number>();
    for (const m of pw.maps) {
      covered.add(m.markerIndex);
      m.dataIndices.forEach((i) => covered.add(i));
      const src = rebuiltWad.findMap(m.name);
      if (!src) {
        problems.push(`PWAD map ${m.name} is not in the input`);
        continue;
      }
      const names = (w: WadFile, x: MapScope) => x.dataIndices.map((i) => w.lumps[i]!.name);
      if (names(pw, m).join(" ") !== names(rebuiltWad, src).join(" ")) problems.push(`${m.name}: PWAD lumps ${names(pw, m).join(" ")} differ from the input's ${names(rebuiltWad, src).join(" ")}`);
      else m.dataIndices.forEach((i, k) => {
        if (!eqBytes(pw.lumpBytes(i), rebuiltWad!.lumpBytes(src.dataIndices[k]!))) problems.push(`${m.name} ${pw.lumps[i]!.name}: data differs from the patched WAD`);
      });
    }
    const extra = pw.lumps.filter((l) => !covered.has(l.index)).map((l) => l.name);
    if (extra.length > 0) problems.push(`PWAD has lumps outside any map: ${extra.slice(0, 10).join(" ")}`);
    add("pwad-maps", problems.length === 0, problems.length === 0 ? `maps ${pwadMaps.join(", ")}: marker and every data lump present, names and data equal to the patched WAD` : problems.join("; "));
  }

  // 引擎冒烟测试：NECROHEX_ENGINE 优先，没有设置时找默认安装位置；没有运行就不算通过
  const found = findEngine();
  const engine = found.path;
  type EngineRun = { map: string; ok: boolean; passed: readonly string[]; failure?: string };
  let engineReport: { status: "passed" | "failed" | "not_run"; reason: string; path: string | null; source: EngineSource; runs: EngineRun[] };
  const notRun = (why: string) => ({ status: "not_run" as const, reason: `引擎未运行 (engine not run): ${why}`, path: engine, source: found.source, runs: [] });
  if (engine === null) engineReport = notRun("NECROHEX_ENGINE is not set and LOCALAPPDATA is not set, so there is no default location to look in");
  else if (!existsSync(engine)) {
    engineReport = notRun(found.source === "NECROHEX_ENGINE" ? `NECROHEX_ENGINE points to a missing file ${engine}` : `NECROHEX_ENGINE is not set and the default location ${engine} has no engine`);
  } else if (iwad === undefined) engineReport = notRun("iwadPath is required to run the engine");
  else if (pwadMaps.length === 0) engineReport = notRun("the PWAD has no maps");
  else {
    const runs: EngineRun[] = [];
    for (const map of pwadMaps) {
      try {
        const r = await runEngineSmoke({ engine, iwad, pwad: pwadFile.path, map, tics });
        runs.push({ map, ok: r.ok, passed: r.passed, ...(r.failure !== undefined ? { failure: r.failure } : {}) });
      } catch (e) {
        runs.push({ map, ok: false, passed: [], failure: `could not start the engine: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    const ok = runs.every((r) => r.ok);
    engineReport = {
      status: ok ? "passed" : "failed",
      reason: ok ? `the engine loaded the PWAD, ran ${tics} tics on each map and exited with code 0` : "the engine smoke test failed",
      path: engine,
      source: found.source,
      runs,
    };
  }

  const anyFailed = checks.some((c) => c.status === "failed") || engineReport.status === "failed";
  const status = anyFailed ? ("failed" as const) : engineReport.status === "not_run" ? ("incomplete" as const) : ("passed" as const);
  return {
    status,
    verified: status === "passed",
    checks,
    engine: engineReport,
    note:
      status === "passed"
        ? "The checks listed above passed. They show the invariants hold and the engine loaded the PWAD and ran the listed tics; they do not show that the map can be finished."
        : status === "incomplete"
          ? "引擎未运行，校验不完整，不能算通过 (the engine did not run, so verification is incomplete and does not count as a pass). The static checks are listed above."
          : "Verification failed; see the failed checks.",
  };
}
