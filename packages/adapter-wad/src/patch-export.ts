/**
 * 补丁结果的 PWAD 导出，CLI 的 apply 和工作台共用。
 * 引擎输出是一份新字节，重新解析它得到的 WadFile 没有脏区间，exportPwad 就无法标出哪些地图改了、也无法检查改动是否都在导出范围内。
 * 所以在输入上按记录和字段（WadFile.setField）重放引擎实际改动的条目，核对与引擎输出逐字节相同，再交给 exportPwad。
 * 只导出有改动的地图；每张地图带标记和全部数据 Lump（由 exportPwad 保证）。
 */
import type { ApplyResult, PlannedChange } from "@necrohex/core";
import { exportPwad, WadExportError, type PwadExport } from "./export.ts";
import { WadFile, type MapScope } from "./wad.ts";

const WRITABLE_LUMP: Readonly<Record<string, string>> = { Sector: "SECTORS", Thing: "THINGS" };

/** 作用域 id（wadAdapter 的 MAP01，或同名地图时的 MAP01@<markerIndex>）对应的地图。 */
export function scopeMap(wad: WadFile, scope: string): MapScope | undefined {
  const at = scope.indexOf("@");
  if (at < 0) return wad.findMap(scope);
  const name = scope.slice(0, at).toUpperCase();
  const marker = Number(scope.slice(at + 1));
  return wad.maps.find((m) => m.name.toUpperCase() === name && m.markerIndex === marker);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 在输入上重放 changes 中 unchanged 为 false 的条目，返回带脏区间的 WadFile。
 * 给出 expected 时，结果必须与它逐字节相同。条目指向的记录不可写、写入被拒绝或结果不同时抛 WadExportError(REPLAY_MISMATCH)。
 */
export function replayChanges(input: Uint8Array, changes: readonly PlannedChange[], expected?: Uint8Array): WadFile {
  const wad = WadFile.parse(input);
  for (const e of changes) {
    if (e.unchanged) continue;
    const m = scopeMap(wad, e.scope);
    const lumpName = WRITABLE_LUMP[e.record];
    const lump = m && lumpName ? m.lumps[lumpName] : undefined;
    if (lump === undefined) throw new WadExportError("REPLAY_MISMATCH", `${e.scope} ${e.record} #${e.index} is not a writable record in the input`);
    try {
      wad.setField(lump, e.record as "Sector", e.index, e.field as never, e.newValue as never);
    } catch (err) {
      throw new WadExportError("REPLAY_MISMATCH", `${e.scope} ${e.record} #${e.index} ${e.field}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (expected && !equal(wad.serialize(), expected)) {
    throw new WadExportError("REPLAY_MISMATCH", "replaying the patch's changes on the input does not give the engine's output");
  }
  return wad;
}

/**
 * applyPatch 成功的结果导出为 PWAD，只含有改动的地图。
 * 没有任何字节改变时抛 WadExportError(NOTHING_TO_EXPORT)；其余拒绝来自 replayChanges 和 exportPwad。不修改 input。
 */
export function exportPatchPwad(input: Uint8Array, result: ApplyResult): PwadExport {
  if (!result.ok || !result.output) throw new TypeError("exportPatchPwad needs a successful applyPatch result with output");
  const changed = result.changes.filter((c) => !c.unchanged);
  if (changed.length === 0) {
    throw new WadExportError("NOTHING_TO_EXPORT", "the patch changes no bytes on this input (every new value equals the old one)");
  }
  const scopes = [...new Set(changed.map((c) => c.scope))];
  const wad = replayChanges(input, result.changes, result.output);
  return exportPwad(wad, { maps: scopes.map((s) => s.split("@")[0]!) });
}
