<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { LEGEND, lightFill, typeName } from "../state/constants.ts";
import { useStore } from "../state/inject.ts";
import { decodeRecord, indexPlan, recKey, type Sel } from "../state/logic.ts";

const store = useStore();
const { state } = store;
const map = computed(() => store.map.value);
const plan = computed(() => (store.plan.value && store.plan.value.scope === state.scope ? store.plan.value : null));
const svg = ref<SVGSVGElement | null>(null);

const PAD = 64;
const full = computed(() => {
  const [bx0, by0, bx1, by1] = map.value?.bounds ?? [-512, -512, 512, 512];
  return { x: bx0 - PAD, y: -by1 - PAD, w: bx1 - bx0 + PAD * 2, h: by1 - by0 + PAD * 2 };
});
const vb = ref({ ...full.value });
const viewBox = computed(() => `${vb.value.x} ${vb.value.y} ${vb.value.w} ${vb.value.h}`);

const okPlan = computed(() => !!plan.value?.ok);
const showAfter = computed(() => state.after && okPlan.value);
const index = computed(() => (plan.value ? indexPlan(plan.value) : null));

const sectorStates = computed(() => {
  const m = map.value;
  if (!m || !m.lumps.SECTORS) return [];
  const bytes = showAfter.value && plan.value?.after?.SECTORS ? plan.value.after.SECTORS : m.lumps.SECTORS.bytes;
  const focus = state.focus;
  const ix = index.value;
  return m.sectors.map((_, i) => {
    const s = decodeRecord("Sector", bytes, i);
    const cs = ix?.byKey.get(recKey("Sector", i)) ?? [];
    const bl = ix?.blocked.get(recKey("Sector", i)) ?? [];
    return {
      fill: lightFill(s["lightlevel"] as number, String(s["floorpic"]).toUpperCase() === "BLOOD1"),
      stained: !!focus && !ix?.relocOps.has(focus) && cs.some((c) => c.op === focus),
      review: cs.some((c) => c.kind === "RELOCATED") && (!focus || cs.some((c) => c.op === focus)),
      blockedfill: bl.length > 0 && (!focus || bl.some((x) => x.op === focus)),
      sel: state.sel?.record === "Sector" && state.sel.index === i,
    };
  });
});

const thingStates = computed(() => {
  const m = map.value;
  if (!m) return [];
  const focus = state.focus;
  const ix = index.value;
  return m.things.map(([x, y, angle, type], i) => {
    const cs = ix?.byKey.get(recKey("Thing", i)) ?? [];
    const bl = ix?.blocked.get(recKey("Thing", i)) ?? [];
    return {
      x,
      y,
      angle,
      player: type >= 1 && type <= 4,
      title: `Thing #${i}: ${typeName(type)}`,
      changed: cs.length > 0 && (showAfter.value || !!focus) && (!focus || cs.some((c) => c.op === focus)),
      blocked: bl.length > 0,
      sel: state.sel?.record === "Thing" && state.sel.index === i,
    };
  });
});

const ghosts = computed(() => {
  const m = map.value;
  if (!m || !plan.value) return [];
  return plan.value.pins.filter((p) => p.result === "RELOCATED" && p.scope === state.scope && m.sectors[p.expectedIndex]).map((p) => m.sectors[p.expectedIndex]!.d);
});

function zoomTo(sel: Sel | null): void {
  const m = map.value;
  if (!m || !sel) {
    vb.value = { ...full.value };
    return;
  }
  let x: number;
  let y: number;
  if (sel.record === "Thing") {
    const t = m.things[sel.index];
    if (!t) return;
    [x, y] = [t[0], -t[1]];
  } else {
    const b = m.sectors[sel.index]?.bbox;
    if (!b) return;
    [x, y] = [(b[0] + b[2]) / 2, -(b[1] + b[3]) / 2];
  }
  vb.value = { x: x - 450, y: y - 450, w: 900, h: 900 };
}

watch(map, () => {
  vb.value = { ...full.value };
});
/** 与 extra.css 里窄屏顶栏的断点相同。 */
const NARROW = "(max-width: 600px)";
const narrow = () => typeof matchMedia === "function" && matchMedia(NARROW).matches;
watch(
  () => state.zoom.n,
  () => void nextTick(() => zoomTo(state.zoom.fitOnNarrow && narrow() ? null : state.zoom.sel)),
);

let drag: { x: number; y: number; vb: typeof vb.value; moved: boolean } | null = null;
const dragging = ref(false);

function onDown(e: PointerEvent): void {
  drag = { x: e.clientX, y: e.clientY, vb: { ...vb.value }, moved: false };
  svg.value?.setPointerCapture(e.pointerId);
}
function onMove(e: PointerEvent): void {
  if (!drag || !svg.value) return;
  const r = svg.value.getBoundingClientRect();
  const k = Math.max(vb.value.w / r.width, vb.value.h / r.height);
  if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) {
    drag.moved = true;
    dragging.value = true;
  }
  if (!drag.moved) return;
  vb.value = { ...drag.vb, x: drag.vb.x - (e.clientX - drag.x) * k, y: drag.vb.y - (e.clientY - drag.y) * k };
}
function onUp(e: PointerEvent): void {
  dragging.value = false;
  if (drag && !drag.moved) {
    const t = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.closest(".th") || n.classList.contains("sec"));
    if (t) {
      const th = t.closest<SVGGElement>(".th");
      const i = Number((th ?? t).getAttribute("data-i"));
      void store.select({ record: th ? "Thing" : "Sector", index: i }, false);
    }
  }
  drag = null;
}
function onWheel(e: WheelEvent): void {
  if (!svg.value) return;
  const r = svg.value.getBoundingClientRect();
  const cur = vb.value;
  const w = Math.min(full.value.w * 1.5, Math.max(200, cur.w * Math.exp(e.deltaY * 0.0015)));
  const f = w / cur.w;
  const k = Math.max(cur.w / r.width, cur.h / r.height);
  const cx = cur.x + cur.w / 2 + (e.clientX - r.left - r.width / 2) * k;
  const cy = cur.y + cur.h / 2 + (e.clientY - r.top - r.height / 2) * k;
  vb.value = { x: cx - (cx - cur.x) * f, y: cy - (cy - cur.y) * f, w, h: cur.h * f };
}

const mapName = computed(() => map.value?.name ?? state.scope.split("@")[0]!);
const message = computed(() => (map.value ? null : state.error ?? state.loading ?? "Loading the map…"));
</script>

<template>
  <section class="panel mapp" aria-label="Map">
    <h2>
      Map <span class="n">{{ mapName }}</span>
      <select v-if="state.wad" class="mapsel" aria-label="Choose a map" :value="state.scope" @change="store.setScope(($event.target as HTMLSelectElement).value)">
        <option v-for="m in state.wad.maps" :key="m.name + (m.scope ?? m.format)" :value="m.scope ?? ''" :disabled="!m.scope">
          {{ m.name }}{{ m.scope ? "" : ` (${m.format}, not supported)` }}
        </option>
      </select>
    </h2>
    <div class="mapwrap">
      <svg
        id="map"
        ref="svg"
        :class="['map', { drag: dragging }]"
        role="img"
        :aria-label="`${mapName} floor plan`"
        :viewBox="viewBox"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @wheel.prevent="onWheel"
      >
        <g>
          <path
            v-for="(s, i) in map?.sectors ?? []"
            :key="i"
            :d="s.d"
            :class="['sec', { stained: sectorStates[i]?.stained, review: sectorStates[i]?.review, blockedfill: sectorStates[i]?.blockedfill, sel: sectorStates[i]?.sel }]"
            fill-rule="evenodd"
            :data-i="i"
            :style="{ fill: sectorStates[i]?.fill }"
          />
        </g>
        <g v-memo="[map]">
          <line v-for="(l, i) in map?.lines ?? []" :key="i" :x1="l[0]" :y1="-l[1]" :x2="l[2]" :y2="-l[3]" :class="l[4] >= 0 && l[5] >= 0 ? 'two' : 'one'" />
        </g>
        <g>
          <path v-for="(d, i) in ghosts" :key="i" :d="d" class="ghost" fill-rule="evenodd" />
        </g>
        <g>
          <g
            v-for="(t, i) in thingStates"
            :key="i"
            :class="['th', { player: t.player, changed: t.changed, blocked: t.blocked, sel: t.sel }]"
            :transform="`translate(${t.x} ${-t.y})`"
            :data-i="i"
          >
            <path v-if="t.player" d="M18 0 L-12 12 L-6 0 L-12 -12 Z" :transform="`rotate(${-t.angle})`" />
            <circle v-else r="11" />
            <title>{{ t.title }}</title>
          </g>
        </g>
      </svg>
      <div class="maptools">
        <div class="seg" role="group" aria-label="Show map state">
          <button id="vBefore" type="button" :aria-pressed="showAfter ? 'false' : 'true'" @click="store.setAfter(false)">Before</button>
          <button id="vAfter" type="button" :aria-pressed="showAfter ? 'true' : 'false'" :disabled="!okPlan" :title="okPlan ? '' : 'The patch is rejected, so there is no after state'" @click="store.setAfter(true)">After</button>
        </div>
        <button id="fit" class="btn" type="button" @click="zoomTo(null)">Fit</button>
        <span class="hint">Scroll to zoom · drag to pan · click a sector or thing to edit it</span>
      </div>
      <div id="legend" class="legend">
        <span v-for="[c, t] in LEGEND" :key="t"><i :style="`background:${c}`"></i>{{ t }}</span>
      </div>
      <div v-if="message" class="mapmsg">{{ message }}</div>
    </div>
  </section>
</template>
