<script setup lang="ts">
import { computed, ref } from "vue";
import { SAMPLE } from "../sample.ts";
import { useStore } from "../state/inject.ts";

const store = useStore();
const { state } = store;
const wadInput = ref<HTMLInputElement | null>(null);
const patchInput = ref<HTMLInputElement | null>(null);
const copying = `${import.meta.env.BASE_URL}${SAMPLE.copyingPath}`;

const hash = computed(() => (state.wad ? state.wad.sha256.replace(/^sha256:/, "").slice(0, 12) : ""));
const canExport = computed(() => !!store.plan.value?.ok && store.plan.value.changedCount > 0 && !state.exporting);

function pick(input: HTMLInputElement | null, then: (f: File) => Promise<void>): void {
  const f = input?.files?.[0];
  if (!f || !input) return;
  input.value = "";
  void then(f);
}
</script>

<template>
  <header class="bar">
    <div class="mark">Necro<b>Hex</b></div>
    <div id="specimen" class="specimen">
      <template v-if="state.wad">
        <span>file <strong>{{ state.wad.name }}</strong></span>
        <span v-if="state.wad.version"><strong><a :href="copying" target="_blank" rel="noopener" title="Freedoom license (BSD)">{{ state.wad.version }}</a></strong></span>
        <span v-else><strong>{{ state.wad.kind }}</strong> · {{ state.wad.lumpCount }} lumps</span>
        <span>sha256 {{ hash }}…</span>
        <span v-if="state.wad.baseIwad">base <strong>{{ state.wad.baseIwad }}</strong></span>
      </template>
    </div>
    <div class="spacer"></div>
    <button id="openWad" class="btn" type="button" title="Open a WAD file from your computer. It stays in this browser." @click="wadInput?.click()">Open WAD</button>
    <input ref="wadInput" class="sr-file" type="file" accept=".wad,.WAD" tabindex="-1" aria-hidden="true" @change="pick(wadInput, store.openWad)" />
    <button id="openPatch" class="btn" type="button" title="Open a *.nhpatch.json file" @click="patchInput?.click()">Open patch</button>
    <input ref="patchInput" class="sr-file" type="file" accept=".json,application/json" tabindex="-1" aria-hidden="true" @change="pick(patchInput, store.importPatch)" />
    <button id="export" class="btn" type="button" :disabled="!canExport" :title="canExport ? 'Apply the patch and download a PWAD with the changed maps' : 'The patch must be ready and change at least one byte'" @click="store.exportPwad()">Export PWAD</button>
  </header>
</template>
