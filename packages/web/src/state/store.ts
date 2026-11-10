/**
 * 工作台的响应式状态和动作。字段与 Mockup 的 state 相同（preset、patch、off、after、focus、sel），
 * 另加打开的文件、当前地图和 Planner_Worker 的结果。派生计算都在 logic.ts。
 */
import { reactive, shallowRef } from "vue";
import { SAMPLE } from "../sample.ts";
import { debounce, PlannerClient } from "../worker/client.ts";
import type { ExportView, MapData, PlanView, ReceiptView, WadSummary } from "../worker/protocol.ts";
import {
  activePatch,
  clone,
  editorOperation,
  initialSelection,
  isEdited,
  removeOperation,
  setChangeParam,
  upsertOperation,
  type Json,
  type Sel,
} from "./logic.ts";
import { BUILTIN_PRESETS, type Preset } from "./presets.ts";

/** 数值控件的防抖。开关和预设切换不防抖。 */
export const PLAN_DEBOUNCE_MS = 150;

export interface ZoomRequest {
  readonly n: number;
  readonly sel: Sel | null;
}

export function createStore(client: PlannerClient, baseUrl: string) {
  const state = reactive({
    presetOk: [] as (boolean | null)[],
    preset: 0,
    off: new Set<string>(),
    after: true,
    focus: null as string | null,
    sel: null as Sel | null,
    scope: "MAP01",
    wad: null as WadSummary | null,
    receipt: null as ReceiptView | null,
    loading: "Opening the built-in sample…" as string | null,
    error: null as string | null,
    notice: null as string | null,
    zoom: { n: 0, sel: null } as ZoomRequest,
    exporting: false,
    exportResult: null as ExportView | null,
  });
  // 补丁 JSON 是递归类型，放在 shallowRef 里：整体替换，不做深层响应式
  const patch = shallowRef<Json>(clone(BUILTIN_PRESETS[0]!.patch));
  const presets = shallowRef<readonly Preset[]>([...BUILTIN_PRESETS]);
  const map = shallowRef<MapData | null>(null);
  const plan = shallowRef<PlanView | null>(null);
  let seq = 0;
  /** 预设刚载入：规划结果回来后按 Mockup 的规则选中并缩放。 */
  let selectAfterPlan = true;

  const edited = () => isEdited(patch.value, presets.value[state.preset]!.patch, state.off);
  const zoomTo = (sel: Sel | null) => {
    state.zoom = { n: state.zoom.n + 1, sel };
  };

  async function runPlan(): Promise<void> {
    if (!state.wad) return;
    const mine = ++seq;
    const active = activePatch(patch.value, state.off);
    const res = await client.request({ type: "plan", seq: mine, patch: active, scope: state.scope });
    if (res.type !== "plan" || res.plan.seq !== seq) return;
    plan.value = res.plan;
    if (!res.plan.ok) state.after = false;
    if (selectAfterPlan) {
      selectAfterPlan = false;
      state.sel = initialSelection(res.plan);
      zoomTo(state.sel);
    }
    state.receipt = null;
    if (res.plan.ok && !edited()) {
      const r = await client.request({ type: "receipt", seq: mine, patch: active });
      if (r.type === "receipt" && r.receipt.seq === seq) state.receipt = r.receipt;
    }
  }
  const planSoon = debounce(() => void runPlan(), PLAN_DEBOUNCE_MS);
  const planNow = () => {
    planSoon.cancel();
    void runPlan();
  };

  async function refreshStatus(): Promise<void> {
    const res = await client.request({ type: "status", patches: presets.value.map((p) => p.patch) });
    state.presetOk = res.type === "status" ? [...res.ok] : presets.value.map(() => null);
  }

  async function loadMap(scope: string): Promise<boolean> {
    const res = await client.request({ type: "map", scope });
    if (res.type !== "map") {
      state.error = res.type === "error" ? res.message : `could not load ${scope}`;
      return false;
    }
    state.scope = scope;
    map.value = res.map;
    return true;
  }

  const defaultScope = (w: WadSummary) => w.maps.find((m) => m.scope && m.name.toUpperCase() === "MAP01")?.scope ?? w.maps.find((m) => m.scope)?.scope ?? null;

  async function openBytes(name: string, bytes: Uint8Array, sample: boolean): Promise<void> {
    state.loading = `Opening ${name}…`;
    state.error = null;
    const res = await client.request(
      { type: "open", name, bytes, ...(sample ? { sample: { sha256: SAMPLE.wadSha256, version: SAMPLE.version } } : {}) },
      [bytes.buffer as ArrayBuffer],
    );
    state.loading = null;
    if (res.type !== "open") {
      state.error = res.type === "error" ? res.message : `could not open ${name}`;
      return;
    }
    const scope = defaultScope(res.summary);
    if (!scope) state.error = `${name} has no Doom-format map that the workbench can edit`;
    state.wad = res.summary;
    map.value = null;
    plan.value = null;
    state.sel = null;
    state.after = true;
    if (scope && (await loadMap(scope))) {
      selectAfterPlan = true;
      planNow();
      await refreshStatus();
    }
  }

  function loadPreset(i: number): void {
    state.preset = i;
    patch.value = clone(presets.value[i]!.patch);
    state.off = new Set();
    state.focus = null;
    state.after = true;
    state.receipt = null;
    selectAfterPlan = true;
    planNow();
  }

  return {
    state,
    patch,
    presets,
    map,
    plan,
    edited,
    loadPreset,

    async init(): Promise<void> {
      try {
        const res = await fetch(`${baseUrl}${SAMPLE.wadPath}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await openBytes(SAMPLE.file, new Uint8Array(await res.arrayBuffer()), true);
      } catch (e) {
        state.loading = null;
        state.error = `The built-in sample could not be loaded (${e instanceof Error ? e.message : String(e)}). Open a WAD file instead.`;
      }
    },

    async openWad(file: File): Promise<void> {
      await openBytes(file.name, new Uint8Array(await file.arrayBuffer()), false);
    },

    async importPatch(file: File): Promise<void> {
      let value: Json;
      try {
        value = JSON.parse(await file.text()) as Json;
      } catch (e) {
        state.notice = `${file.name} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
        return;
      }
      state.notice = null;
      presets.value = [...presets.value, { file: file.name, patch: value, imported: true }];
      loadPreset(presets.value.length - 1);
      await refreshStatus();
    },

    reset(): void {
      loadPreset(state.preset);
    },

    async setScope(scope: string): Promise<void> {
      if (scope === state.scope) return;
      state.sel = null;
      if (await loadMap(scope)) {
        zoomTo(null);
        planNow();
      }
    },

    toggleOp(id: string, on: boolean): void {
      const off = new Set(state.off);
      if (on) off.delete(id);
      else off.add(id);
      state.off = off;
      planNow();
    },

    setParam(id: string, field: string, key: "set" | "scale", value: Json): void {
      patch.value = setChangeParam(patch.value, id, field, key, value);
      planSoon();
    },

    removeOp(id: string): void {
      patch.value = removeOperation(patch.value, id);
      const off = new Set(state.off);
      off.delete(id);
      state.off = off;
      if (state.focus === id) state.focus = null;
      planNow();
    },

    toggleFocus(id: string): void {
      state.focus = state.focus === id ? null : id;
    },

    setAfter(after: boolean): void {
      state.after = after;
    },

    /** 选中记录；scope 不同时先切换地图。 */
    async select(sel: Sel, zoom: boolean, scope?: string | null): Promise<void> {
      if (scope && scope !== state.scope) {
        if (!(await loadMap(scope))) return;
        planNow();
      }
      state.sel = sel;
      if (zoom) zoomTo(sel);
    },

    applyEditor(sel: Sel, base: Readonly<Record<string, number | string>>, values: Readonly<Record<string, string>>): void {
      const m = map.value;
      if (!m) return;
      const op = editorOperation(sel, base, values, m.name, sel.record === "Sector" ? m.fingerprints[sel.index] : undefined);
      let next = removeOperation(patch.value, `edit-${sel.record.toLowerCase()}-${sel.index}`);
      if (op) {
        next = upsertOperation(next, op, m.name);
        const off = new Set(state.off);
        off.delete(op["id"] as string);
        state.off = off;
        state.focus = op["id"] as string;
      }
      patch.value = next;
      state.after = true;
      planNow();
    },

    async exportPwad(): Promise<void> {
      state.exporting = true;
      state.exportResult = null;
      const res = await client.request({ type: "export", patch: activePatch(patch.value, state.off) });
      state.exporting = false;
      state.exportResult = res.type === "export" ? res.result : { ok: false, code: res.type === "error" ? res.code : "INTERNAL", message: res.type === "error" ? res.message : "export failed", issues: [] };
    },

    closeExport(): void {
      state.exportResult = null;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
