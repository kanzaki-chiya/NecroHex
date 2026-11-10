<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { download, useStore } from "../state/inject.ts";
import { defaultWadName, exportFileName, patchName, receiptFileName } from "../state/logic.ts";
import IssueCard from "./IssueCard.vue";

const store = useStore();
const { state } = store;
const dlg = ref<HTMLDialogElement | null>(null);
const name = ref("");
const fallback = computed(() => defaultWadName(patchName(store.patch.value)));
const fileName = computed(() => exportFileName(name.value, fallback.value));
const result = computed(() => state.exportResult);
const open = computed(() => state.exporting || state.exportResult !== null);
const summary = computed(() => {
  const r = result.value;
  if (!r?.ok) return "";
  const count = (s: string) => r.checks.filter((c) => c.status === s).length;
  return `${count("passed")} checks passed, ${count("warned")} warned, ${count("allowed")} allowed by the patch, ${count("failed")} failed.`;
});

watch(open, (o) => {
  if (o) {
    name.value = fallback.value;
    if (!dlg.value?.open) dlg.value?.showModal();
  } else if (dlg.value?.open) dlg.value.close();
});

function savePwad(): void {
  const r = result.value;
  if (r?.ok) download(r.pwad, fileName.value, "application/octet-stream");
}
function saveReceipt(): void {
  const r = result.value;
  if (r?.ok) download(r.receiptJson, receiptFileName(fileName.value), "application/json");
}
</script>

<template>
  <dialog ref="dlg" class="export" aria-label="Export PWAD" @close="store.closeExport()">
    <h2><span class="grow">Export PWAD</span><button class="btn small" type="button" @click="store.closeExport()">Close</button></h2>
    <div class="body">
      <div v-if="state.exporting" class="note">Applying the patch and building the PWAD…</div>
      <template v-else-if="result?.ok">
        <label class="label" for="exportName">File name</label>
        <input id="exportName" v-model="name" type="text" spellcheck="false" />
        <div v-if="fileName !== name" class="note">Saved as {{ fileName }}</div>
        <div class="label">Maps in the PWAD</div>
        <ul>
          <li v-for="m in result.maps" :key="m.name">{{ m.name }} · marker and {{ m.lumps.length - 1 }} data lumps{{ m.modified ? " · changed" : "" }}</li>
        </ul>
        <div class="row">
          <button id="savePwad" class="btn primary small" type="button" @click="savePwad">Download {{ fileName }}</button>
          <button id="saveReceipt" class="btn small" type="button" @click="saveReceipt">Download receipt</button>
        </div>
        <div class="hash">pwad {{ result.pwadSha256 }}</div>
        <div class="hash">receipt in {{ result.receipt.inputHash }}<br />receipt out {{ result.receipt.outputHash }}<br />patch {{ result.receipt.patchHash }} · {{ result.receipt.entries }} entries</div>
        <div class="label">What was checked</div>
        <ul>
          <li v-for="c in result.exportChecks" :key="c">{{ c }}</li>
          <li>{{ summary }}</li>
        </ul>
        <div class="note">
          These are static checks. They report what was checked; they do not show that the map can be finished. Load the PWAD on top of
          {{ state.wad?.baseIwad ?? state.wad?.name }} in your engine. The receipt maps the full input WAD to the full patched WAD and is what revert and verify use.
        </div>
      </template>
      <template v-else-if="result">
        <div class="big" style="font: 600 18px/1.2 var(--display)">Nothing was exported</div>
        <div class="note">{{ result.message }}</div>
        <IssueCard v-for="(i, k) in result.issues.slice(0, 8)" :key="k" :warn="false" :code="i.code" :m="i.message" :more="i.op ? `operation ${i.op}` : ''" :static="true" />
      </template>
    </div>
  </dialog>
</template>
