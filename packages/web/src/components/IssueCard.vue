<script setup lang="ts">
defineProps<{ warn: boolean; code: string; m: string; more: string; static?: boolean }>();
defineEmits<{ pick: [] }>();
</script>

<template>
  <div class="issue" :class="{ warn }" :style="static ? 'cursor:default' : undefined" @click="$emit('pick')">
    <div class="code">{{ code }}</div>
    <div class="m">{{ m }}</div>
    <div class="more">{{ more }}</div>
  </div>
</template>
