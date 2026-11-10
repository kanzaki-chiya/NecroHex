<script setup lang="ts">
import { computed } from "vue";
import AppHeader from "./components/AppHeader.vue";
import ExportDialog from "./components/ExportDialog.vue";
import MapPanel from "./components/MapPanel.vue";
import PatchPanel from "./components/PatchPanel.vue";
import RecordPanel from "./components/RecordPanel.vue";
import { THING_OPTIONS } from "./state/constants.ts";
import { useStore } from "./state/inject.ts";

const store = useStore();
const flats = computed(() => store.map.value?.flats ?? []);
</script>

<template>
  <div class="app">
    <AppHeader />
    <main>
      <PatchPanel />
      <MapPanel />
      <RecordPanel />
    </main>
  </div>
  <datalist id="flatlist">
    <option v-for="f in flats" :key="f" :value="f" />
  </datalist>
  <datalist id="typelist">
    <option v-for="t in THING_OPTIONS" :key="t.value" :value="t.value" :label="t.label" />
  </datalist>
  <ExportDialog />
</template>
