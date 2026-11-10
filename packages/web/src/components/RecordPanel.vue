<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { SPECIAL, SPECIAL_OPTIONS, typeName } from "../state/constants.ts";
import { useStore } from "../state/inject.ts";
import { decodeRecord, EDITOR_FIELDS, editorValues, indexPlan, operationsOf, recordCount, recordView, userOpId, LAYOUT } from "../state/logic.ts";
import HexBlock from "./HexBlock.ts";
import IssueCard from "./IssueCard.vue";

const store = useStore();
const { state } = store;
const map = computed(() => store.map.value);
const plan = computed(() => (store.plan.value && store.plan.value.scope === state.scope ? store.plan.value : null));

const sel = computed(() => {
  const s = state.sel;
  const m = map.value;
  return s && m && s.index >= 0 && s.index < recordCount(m, s.record) ? s : null;
});
const view = computed(() => {
  const m = map.value;
  const p = plan.value;
  const s = sel.value;
  if (!m || !p || !s) return null;
  return recordView(s, m, p, indexPlan(p), state.after && p.ok, state.wad?.name ?? "");
});

/** 记录的输入值（编辑器比较用）。 */
const base = computed(() => {
  const s = sel.value;
  const m = map.value;
  if (!s || !m) return null;
  const l = m.lumps[LAYOUT[s.record].lump];
  return l ? decodeRecord(s.record, l.bytes, s.index) : null;
});
const existing = computed(() => (sel.value ? operationsOf(store.patch.value).some((o) => o.id === userOpId(sel.value!)) : false));
const fields = computed(() => (sel.value ? EDITOR_FIELDS[sel.value.record] : []));
const values = reactive<Record<string, string>>({});

watch(
  [sel, base, () => store.patch.value],
  () => {
    for (const k of Object.keys(values)) delete values[k];
    if (sel.value && base.value) Object.assign(values, editorValues(store.patch.value, sel.value, base.value));
  },
  { immediate: true },
);

const dirty = (f: string) => base.value !== null && String(values[f]) !== String(base.value[f]);
const specialMissing = computed(() => values["special"] !== undefined && !(Number(values["special"]) in SPECIAL));

function apply(): void {
  if (sel.value && base.value) store.applyEditor(sel.value, base.value, { ...values });
}
function remove(): void {
  if (sel.value) store.removeOp(userOpId(sel.value));
}
</script>

<template>
  <section class="panel" aria-label="Record">
    <h2>Record</h2>
    <div class="scroll">
      <div id="rec" class="rec">
        <template v-if="view">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px">
            <div class="title">{{ view.title }}</div>
            <span :class="['pill', view.pill.cls]">{{ view.pill.text }}</span>
          </div>
          <div class="sub">{{ view.sub }}</div>
          <table class="fields">
            <tbody>
              <tr v-for="r in view.rows" :key="r.name" :class="r.cls">
                <td>{{ r.name }}</td>
                <td v-if="r.cell.kind === 'blocked'">{{ r.cell.text }}<span>{{ r.cell.mark }}</span></td>
                <td v-else-if="r.cell.kind === 'changed'"><span class="old">{{ r.cell.old }}</span>{{ r.cell.text }}</td>
                <td v-else-if="r.cell.kind === 'pending'">{{ r.cell.text }}<span class="note">{{ r.cell.note }}</span></td>
                <td v-else>{{ r.cell.text }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="view.by" class="sub">{{ view.by }}</div>
          <div v-if="view.reasonsLabel" style="display: grid; gap: 6px">
            <div class="label">{{ view.reasonsLabel }}</div>
            <IssueCard v-for="(c, i) in view.reasons" :key="i" :warn="c.warn" :code="c.code" :m="c.m" :more="c.more" :static="true" />
          </div>
          <div v-else-if="view.reasonNote" class="note">{{ view.reasonNote }}</div>
        </template>
        <div v-else class="note">Click a sector or thing on the map to inspect and edit it.</div>
      </div>
      <div id="editor" class="editor" :hidden="!view">
        <template v-if="view && sel">
          <div class="label">Edit this {{ sel.record.toLowerCase() }}</div>
          <div class="grid">
            <template v-for="f in fields" :key="f">
              <label :for="`ed-${f}`">{{ f }}</label>
              <select v-if="f === 'special'" :id="`ed-${f}`" v-model="values[f]" :class="{ dirty: dirty(f) }">
                <option v-for="[k, t] in SPECIAL_OPTIONS" :key="k" :value="String(k)">{{ k }} · {{ t }}</option>
                <option v-if="specialMissing" :value="values[f]">{{ values[f] }}</option>
              </select>
              <input v-else-if="f === 'type'" :id="`ed-${f}`" v-model="values[f]" type="number" list="typelist" :class="{ dirty: dirty(f) }" />
              <input v-else-if="f === 'lightlevel'" :id="`ed-${f}`" v-model="values[f]" type="number" min="0" max="255" step="8" :class="{ dirty: dirty(f) }" />
              <input v-else :id="`ed-${f}`" v-model="values[f]" type="text" list="flatlist" spellcheck="false" :class="{ dirty: dirty(f) }" />
            </template>
          </div>
          <div v-if="sel.record === 'Thing'" id="typehint" class="note">{{ typeName(Number(values["type"])) }}</div>
          <div class="row">
            <button class="btn primary small" type="button" @click="apply">{{ existing ? "Update in patch" : "Add to patch" }}</button>
            <button v-if="existing" class="btn small" type="button" @click="remove">Remove from patch</button>
          </div>
          <div class="note">
            {{
              sel.record === "Sector"
                ? "Adds a pinned operation with this sector’s fingerprint. The source file is never edited."
                : "Adds an operation that selects this thing by position and type. The source file is never edited."
            }}
          </div>
        </template>
      </div>
      <div id="hexwrap" class="hexwrap" :hidden="!view">
        <template v-if="view">
          <div id="hexlabel" class="label">{{ view.hex.label }}</div>
          <HexBlock :rows="view.hex.rows" />
          <div id="hexnote" class="note">{{ view.hex.note }}</div>
        </template>
      </div>
    </div>
  </section>
</template>
