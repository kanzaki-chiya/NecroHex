<script setup lang="ts">
import { computed, ref } from "vue";
import { SPECIAL_OPTIONS } from "../state/constants.ts";
import { download, useStore } from "../state/inject.ts";
import {
  activePatch,
  controlValue,
  isObject,
  issueGroups,
  opRows,
  patchFileName,
  patchName,
  pinCards,
  verdictView,
  type IssueCardView,
  type OpControl,
} from "../state/logic.ts";
import IssueCard from "./IssueCard.vue";

const store = useStore();
const { state } = store;

const edited = computed(() => store.edited());
const plan = computed(() => store.plan.value);
// 切换地图后、新的规划结果回来之前，面板仍显示上一张地图的结果，标题跟着结果走
const mapName = computed(() => (plan.value ?? { scope: state.scope }).scope.split("@")[0]!);
const verdict = computed(() => (plan.value ? verdictView(plan.value, store.patch.value, mapName.value, edited.value, state.receipt) : null));
const pins = computed(() => (plan.value ? pinCards(plan.value.pins) : []));
const rows = computed(() => opRows(store.patch.value, state.off, plan.value, state.focus));
const groups = computed(() => (plan.value ? issueGroups(plan.value) : { issues: [], warnings: [] }));
const json = computed(() => JSON.stringify(activePatch(store.patch.value, state.off), null, 2));
const copied = ref("");
const pre = ref<HTMLPreElement | null>(null);

const presetName = (i: number) => {
  const p = store.presets.value[i]!;
  return isObject(p.patch) && typeof p.patch["name"] === "string" ? p.patch["name"] : p.file;
};

function onControl(id: string, c: OpControl, raw: string): void {
  if (c.kind === "scale") store.setParam(id, c.field, "scale", Number(raw));
  else if (c.kind === "special") store.setParam(id, c.field, "set", Number(raw));
  else store.setParam(id, c.field, "set", controlValue(c, raw));
}

function pickIssue(card: IssueCardView): void {
  if (card.target) void store.select({ record: card.target.record, index: card.target.index }, true, card.target.scope);
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(json.value);
    copied.value = "Copied";
  } catch {
    const s = getSelection();
    if (s && pre.value) {
      const rg = document.createRange();
      rg.selectNodeContents(pre.value);
      s.removeAllRanges();
      s.addRange(rg);
    }
    copied.value = "Selected. Press Ctrl+C to copy.";
  }
}

function save(): void {
  download(json.value + "\n", patchFileName(patchName(store.patch.value)), "application/json");
}

const val = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value;
</script>

<template>
  <section class="panel" aria-label="Patch">
    <h2><span class="grow">Patch</span><button id="reset" class="btn small" type="button" :hidden="!edited" @click="store.reset()">Reset</button></h2>
    <div class="scroll">
      <div id="presets" class="presets">
        <button v-for="(p, i) in store.presets.value" :key="i" class="preset" type="button" :aria-pressed="i === state.preset ? 'true' : 'false'" @click="store.loadPreset(i)">
          <span class="t"
            >{{ presetName(i)
            }}<span v-if="i === state.preset && edited" class="pill edit">edited</span
            ><span v-else-if="state.presetOk[i] !== undefined && state.presetOk[i] !== null" :class="['pill', state.presetOk[i] ? 'ok' : 'bad']">{{ state.presetOk[i] ? "ready" : "rejected" }}</span></span
          >
          <span class="f">{{ p.file }}</span>
        </button>
      </div>
      <div v-if="state.notice" class="banner bad">{{ state.notice }}</div>
      <div id="verdict" :class="['verdict', { bad: verdict ? !verdict.ok : !!state.error }]">
        <template v-if="verdict">
          <div class="big">{{ verdict.big }}</div>
          <div class="note">{{ verdict.note }}</div>
          <div v-if="verdict.hash" class="hash">{{ verdict.hash }}</div>
          <div v-if="verdict.warn" class="note" style="color: var(--review)">{{ verdict.warn }}</div>
        </template>
        <template v-else>
          <div class="big">{{ state.error ? "Nothing is open" : "Opening…" }}</div>
          <div class="note">{{ state.error ?? state.loading ?? "Planning the patch…" }}</div>
        </template>
      </div>
      <div v-if="verdict && state.error" class="banner bad" style="margin-top: 8px">{{ state.error }}</div>
      <div id="pins">
        <div v-if="pins.length" class="section">
          <div class="label">Pinned records</div>
          <div
            v-for="pn in pins"
            :key="pn.op"
            class="pin"
            @click="store.select({ record: 'Sector', index: pn.target.index }, true, pn.target.scope)"
          >
            <div style="display: flex; justify-content: space-between; gap: 8px; align-items: center">
              <span style="font: 12px var(--mono); overflow-wrap: anywhere">{{ pn.op }}</span><span :class="['pill', pn.pill]">{{ pn.pillText }}</span>
            </div>
            <div class="route">{{ pn.from }}<i>→</i>{{ pn.to }}</div>
            <div class="msg">{{ pn.msg }}</div>
          </div>
        </div>
      </div>
      <div class="section">
        <div id="opslabel" class="label">Operations · records changed in {{ mapName }}</div>
        <ul id="ops" class="ops">
          <li v-for="o in rows" :key="o.id" :class="['op', { off: o.off, blocked: o.blocked > 0, focused: o.focused }]">
            <input type="checkbox" :aria-label="`Use ${o.id}`" :checked="!o.off" @change="store.toggleOp(o.id, ($event.target as HTMLInputElement).checked)" />
            <span
              class="name"
              role="button"
              tabindex="0"
              title="Show on the map"
              @click="store.toggleFocus(o.id)"
              @keydown.enter.prevent="store.toggleFocus(o.id)"
              @keydown.space.prevent="store.toggleFocus(o.id)"
              >{{ o.id }}</span
            >
            <span class="c">{{ o.count }}</span>
            <button v-if="o.user" class="x" type="button" :aria-label="`Remove ${o.id}`" @click="store.removeOp(o.id)">✕</button>
            <span v-else></span>
            <div v-if="o.control?.kind === 'scale'" class="ctl">
              {{ o.control.field }} scale<input
                type="range"
                min="0.2"
                max="1.2"
                step="0.05"
                :value="String(o.control.value)"
                :aria-label="`${o.id} scale`"
                @input="onControl(o.id, o.control, val($event))"
              /><span class="v">×{{ o.control.value }}</span><span v-if="o.control.clamp">clamp {{ o.control.clamp[0] }}–{{ o.control.clamp[1] }}</span>
            </div>
            <div v-else-if="o.control?.kind === 'special'" class="ctl">
              special =<select
                :aria-label="`${o.id} new special`"
                style="background: var(--table); border: 1px solid var(--rule); border-radius: 3px; font: 12px var(--mono); padding: 2px 4px; min-width: 0; flex: 1"
                :value="String(o.control.value)"
                @change="onControl(o.id, o.control, val($event))"
              >
                <option v-for="[k, t] in SPECIAL_OPTIONS" :key="k" :value="String(k)">{{ k }} · {{ t }}</option>
                <option v-if="!SPECIAL_OPTIONS.some(([k]) => o.control?.kind === 'special' && k === o.control.value)" :value="String(o.control.value)">{{ o.control.value }}</option>
              </select>
            </div>
            <div v-else-if="o.control" class="ctl">
              {{ o.control.field }} =<input
                :type="o.control.kind"
                :value="o.control.value"
                :list="o.control.list ?? undefined"
                :aria-label="`${o.id} new ${o.control.field}`"
                spellcheck="false"
                @change="onControl(o.id, o.control, val($event))"
              /><span>{{ o.control.hint }}</span>
            </div>
          </li>
        </ul>
      </div>
      <div id="issues">
        <div v-if="groups.issues.length" class="section">
          <div class="label">Why it is rejected</div>
          <IssueCard v-for="(g, i) in groups.issues" :key="i" :warn="false" :code="g.code" :m="g.m" :more="g.more" @pick="pickIssue(g)" />
        </div>
        <div v-if="groups.warnings.length" class="section">
          <div class="label">Warnings</div>
          <IssueCard v-for="(g, i) in groups.warnings" :key="i" :warn="true" :code="g.code" :m="g.m" :more="g.more" @pick="pickIssue(g)" />
        </div>
      </div>
      <details id="jsonbox" class="json">
        <summary>Patch JSON</summary>
        <div class="row">
          <button id="copy" class="btn small" type="button" @click="copy">Copy</button
          ><button id="download" class="btn small" type="button" @click="save">Download</button><span id="copied" class="note">{{ copied }}</span>
        </div>
        <pre id="json" ref="pre">{{ json }}</pre>
      </details>
    </div>
  </section>
</template>
