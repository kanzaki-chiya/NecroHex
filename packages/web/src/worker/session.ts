/**
 * Planner_Worker 里的会话：持有当前 WAD、基础 IWAD 和 adapter，所有规划、检查、写入和导出都交给
 * @necrohex/core 和 @necrohex/adapter-wad。这里只把结果整理成界面需要的形状，不判断补丁能否写入。
 * 不依赖 DOM 和 Node，可以在 vitest 里直接测试。
 */
import { applyPatch, bytesHash, patchHash, planPatch, type PatchIssue, type PinResolution, type RecordAdapter } from "@necrohex/core";
import {
  createWadAdapter,
  exportPatchPwad,
  flatNames,
  NO_INDEX,
  replayChanges,
  scopeMap,
  sectorFingerprints,
  sectorOutlines,
  WadExportError,
  WadFile,
  WadParseError,
  type MapScope,
} from "@necrohex/adapter-wad";
import type { ExportView, IssueView, LumpView, MapData, MapEntry, PinView, PlanView, ReceiptView, SectorView, WadSummary } from "./protocol.ts";

export class SessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

interface Opened {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly wad: WadFile;
  readonly summary: WadSummary;
  readonly adapter: RecordAdapter;
  /** scope id → 地图。 */
  readonly scopes: ReadonlyMap<string, MapScope>;
  /** 本文件和基础 IWAD 的 Flat 名，排序。 */
  readonly flats: readonly string[];
}

export function issueView(i: PatchIssue): IssueView {
  return {
    code: i.code,
    message: i.message,
    op: i.operationId ?? i.operationIds?.[0] ?? null,
    ops: i.operationIds ?? (i.operationId !== undefined ? [i.operationId] : []),
    hook: i.hook ?? null,
    reason: i.reason ?? null,
    locator: i.locator ? { scope: i.locator.scope, record: i.locator.record, index: i.locator.index } : null,
    field: i.field ?? null,
    path: i.path ?? null,
  };
}

function pinView(p: PinResolution): PinView {
  return {
    op: p.operationId,
    map: p.map,
    scope: p.scope ?? null,
    result: p.result,
    expectedIndex: p.expectedIndex,
    index: p.index ?? null,
    score: p.score ?? null,
    fingerprintChecked: p.fingerprintChecked,
    candidates: p.candidates,
    message: p.message,
  };
}

/** 扇区轮廓转成 SVG 路径：y 取反，与 Mockup 的写法相同。 */
export function outlinePath(loops: readonly (readonly (readonly [number, number])[])[]): string {
  return loops.map((loop) => loop.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${-y}`).join("") + "Z").join("");
}

export class Session {
  #base: { readonly name: string; readonly bytes: Uint8Array } | null = null;
  #current: Opened | null = null;

  get summary(): WadSummary | null {
    return this.#current?.summary ?? null;
  }

  /**
   * 打开一个 WAD。sample 给出时哈希必须等于它，然后这份字节也作为之后打开的 PWAD 的基础 IWAD。
   * 解析失败或哈希不符时抛 SessionError，之前打开的文件保持不变。
   */
  open(name: string, input: Uint8Array, sample?: { readonly sha256: string; readonly version: string }): WadSummary {
    let wad: WadFile;
    try {
      wad = WadFile.parse(input);
    } catch (e) {
      if (e instanceof WadParseError) throw new SessionError("INVALID_WAD", `${name} is not a readable WAD: ${e.message}`);
      throw e;
    }
    const sha256 = bytesHash(input);
    if (sample && sha256 !== `sha256:${sample.sha256}`) {
      throw new SessionError("SAMPLE_HASH_MISMATCH", `${name} has ${sha256}, expected sha256:${sample.sha256}; the built-in sample was not opened`);
    }
    const bytes = new Uint8Array(input);
    if (sample) this.#base = { name, bytes };
    // 与 CLI 的 --iwad 相同：PWAD 通常不带 Flat，新贴图名在基础 IWAD 里查找
    const base = wad.kind === "PWAD" && this.#base ? this.#base : null;
    const adapter = base ? createWadAdapter({ baseIwad: base.bytes }) : createWadAdapter();
    const flats = new Set(flatNames(wad));
    if (base) for (const f of flatNames(WadFile.parse(base.bytes))) flats.add(f);
    const scopes = new Map<string, MapScope>();
    for (const s of adapter.open(bytes).scopes()) {
      const m = scopeMap(wad, s.id);
      if (m) scopes.set(s.id, m);
    }
    const scopeOf = new Map([...scopes].map(([id, m]) => [m.markerIndex, id]));
    const maps: MapEntry[] = wad.maps.map((m) => ({ scope: scopeOf.get(m.markerIndex) ?? null, name: m.name, format: m.format }));
    const summary: WadSummary = {
      name,
      kind: wad.kind,
      size: bytes.length,
      sha256,
      version: sample?.version ?? null,
      lumpCount: wad.lumps.length,
      maps,
      baseIwad: base?.name ?? null,
    };
    this.#current = { name, bytes, wad, summary, adapter, scopes, flats: [...flats].sort() };
    return summary;
  }

  #opened(): Opened {
    if (!this.#current) throw new SessionError("NO_WAD", "no WAD is open");
    return this.#current;
  }

  #map(scope: string): MapScope {
    const m = this.#opened().scopes.get(scope);
    if (!m) throw new SessionError("NO_MAP", `no Doom-format map ${scope} in this WAD`);
    return m;
  }

  #lump(wad: WadFile, map: MapScope, name: "SECTORS" | "THINGS"): LumpView | null {
    const i = map.lumps[name];
    if (i === undefined) return null;
    const l = wad.lumps[i]!;
    return { lumpIndex: i, offset: l.filepos, bytes: wad.lumpBytes(i) };
  }

  mapData(scope: string): MapData {
    const { wad, flats } = this.#opened();
    const map = this.#map(scope);
    const read = <K extends "Linedef" | "Sidedef" | "Vertex" | "Thing">(lump: string, record: K) => {
      const i = map.lumps[lump];
      return i === undefined ? [] : wad.readRecords(i, record);
    };
    const vertexes = read("VERTEXES", "Vertex");
    const sidedefs = read("SIDEDEFS", "Sidedef");
    const sectorOfSide = (side: number | undefined) => (side === undefined || side === NO_INDEX || side >= sidedefs.length ? -1 : sidedefs[side]!.sector);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    const lines: [number, number, number, number, number, number][] = [];
    for (const l of read("LINEDEFS", "Linedef")) {
      const a = vertexes[l.v1];
      const b = vertexes[l.v2];
      if (!a || !b) continue;
      for (const v of [a, b]) {
        x0 = Math.min(x0, v.x);
        y0 = Math.min(y0, v.y);
        x1 = Math.max(x1, v.x);
        y1 = Math.max(y1, v.y);
      }
      lines.push([a.x, a.y, b.x, b.y, sectorOfSide(l.sidenum[0]), sectorOfSide(l.sidenum[1])]);
    }
    if (lines.length === 0) [x0, y0, x1, y1] = [-512, -512, 512, 512];
    const fingerprints = sectorFingerprints(wad, map);
    const sectors: SectorView[] = sectorOutlines(wad, map).map((o, i) => ({ d: outlinePath(o.loops), bbox: fingerprints[i]?.bbox ?? null }));
    return {
      scope,
      name: map.name,
      bounds: [x0, y0, x1, y1],
      sectors,
      lines,
      things: read("THINGS", "Thing").map((t) => [t.x, t.y, t.angle, t.type, t.flags] as const),
      lumps: { SECTORS: this.#lump(wad, map, "SECTORS"), THINGS: this.#lump(wad, map, "THINGS") },
      fingerprints,
      flats,
    };
  }

  plan(seq: number, patch: unknown, scope: string): PlanView {
    const { bytes, adapter } = this.#opened();
    const r = planPatch(bytes, patch, adapter);
    let ph: string | null = null;
    try {
      ph = patchHash(patch);
    } catch {
      ph = null;
    }
    const changedByScope: Record<string, number> = {};
    for (const c of r.changes) if (!c.unchanged) changedByScope[c.scope] = (changedByScope[c.scope] ?? 0) + 1;
    let after: PlanView["after"] = null;
    if (r.ok && this.#current!.scopes.has(scope)) {
      // 新值的字节由 adapter-wad 的 setField 编码，与导出时的重放是同一条路径
      const replayed = replayChanges(bytes, r.changes);
      const map = this.#map(scope);
      after = { SECTORS: this.#lump(replayed, map, "SECTORS")?.bytes ?? null, THINGS: this.#lump(replayed, map, "THINGS")?.bytes ?? null };
    }
    return {
      seq,
      scope,
      ok: r.ok,
      patchHash: ph,
      pins: r.pins.map(pinView),
      issues: r.issues.map(issueView),
      warnings: r.warnings.map(issueView),
      matches: r.matches,
      changes: r.changes
        .filter((c) => !c.unchanged && c.scope === scope)
        .map((c) => ({ op: c.operationId, record: c.record, index: c.index, field: c.field, oldValue: c.oldValue, newValue: c.newValue, kind: c.selection.kind, span: { start: c.span.start, end: c.span.end } })),
      changedByScope,
      changedCount: r.changedCount,
      checks: r.checks,
      after,
    };
  }

  /** 每个补丁在当前文件上能否写入（预设列表的标签）。 */
  status(patches: readonly unknown[]): boolean[] {
    const { bytes, adapter } = this.#opened();
    return patches.map((p) => planPatch(bytes, p, adapter).ok);
  }

  receipt(seq: number, patch: unknown): ReceiptView {
    const { bytes, adapter } = this.#opened();
    const r = applyPatch(bytes, patch, adapter);
    return { seq, ok: r.ok, patchHash: r.receipt?.patchHash ?? null, inputHash: r.receipt?.inputHash ?? null, outputHash: r.receipt?.outputHash ?? null };
  }

  /** 与 CLI 的 apply 相同：applyPatch，然后 exportPatchPwad；回执文本的格式也相同。不修改已打开的字节。 */
  export(patch: unknown): ExportView {
    const { bytes, adapter } = this.#opened();
    const r = applyPatch(bytes, patch, adapter);
    if (!r.ok) return { ok: false, code: "PATCH_REJECTED", message: "The patch was rejected; nothing was written.", issues: r.issues.map(issueView) };
    let pwad;
    try {
      pwad = exportPatchPwad(bytes, r);
    } catch (e) {
      if (e instanceof WadExportError) return { ok: false, code: e.code, message: e.message, issues: [] };
      throw e;
    }
    const receipt = r.receipt!;
    return {
      ok: true,
      pwad: pwad.bytes,
      pwadSha256: bytesHash(pwad.bytes),
      receiptJson: JSON.stringify(receipt, null, 2) + "\n",
      receipt: { patchHash: receipt.patchHash, inputHash: receipt.inputHash, outputHash: receipt.outputHash, entries: receipt.entries.length },
      maps: pwad.maps.map((m) => ({ name: m.name, lumps: [...m.lumps], modified: m.modified })),
      exportChecks: [...pwad.checks],
      checks: r.checks,
      changedCount: r.changedCount,
    };
  }
}
