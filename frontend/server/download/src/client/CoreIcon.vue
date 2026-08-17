<script setup lang="ts">
import { computed, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    coreId: string;
    label: string;
    iconUrl?: string;
    size?: "card" | "row" | "detail";
  }>(),
  { size: "card" },
);

const imageFailed = ref(false);
watch(
  () => props.iconUrl,
  () => {
    imageFailed.value = false;
  },
);

const knownMarks: Readonly<Record<string, string>> = {
  vanilla: "V",
  "vanilla-snapshot": "VS",
  bungeecord: "BC",
  catserver: "CS",
  lightfall: "LF",
  neoforge: "NF",
  nukkitx: "NX",
  pufferfish: "PF",
  pufferfish_purpur: "PP",
  spongeforge: "SF",
  spongevanilla: "SV",
};

const mark = computed(() => {
  const known = knownMarks[props.coreId];
  if (known) return known;
  const words = props.label.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length > 1)
    return words
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
  return (words[0] ?? props.coreId).slice(0, 2).toUpperCase();
});

const hue = computed(() => {
  let hash = 0;
  for (const character of props.coreId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 360;
});
</script>

<template>
  <span
    class="core-icon"
    :class="[`core-icon-${size}`, { 'core-icon-has-image': iconUrl && !imageFailed }]"
    :style="{ '--core-icon-hue': hue }"
    role="img"
    :aria-label="`${label} 图标`"
  >
    <img
      v-if="iconUrl && !imageFailed"
      :src="iconUrl"
      alt=""
      draggable="false"
      @error="imageFailed = true"
    />
    <span v-else>{{ mark }}</span>
  </span>
</template>

<style scoped>
.core-icon {
  --core-icon-hue: 200;
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border: 1px solid hsl(var(--core-icon-hue) 34% 78%);
  background: hsl(var(--core-icon-hue) 46% 94%);
  color: hsl(var(--core-icon-hue) 54% 29%);
  font-weight: 780;
  letter-spacing: -0.04em;
  line-height: 1;
  user-select: none;
}

.core-icon-has-image {
  border-color: transparent;
  background: transparent;
}

.core-icon > img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}

.core-icon > span {
  transform: translateY(-0.02em);
}

.core-icon-card {
  width: 68px;
  height: 68px;
  border-radius: 18px;
  font-size: 1.15rem;
}

.core-icon-row {
  width: 38px;
  height: 38px;
  border-radius: 11px;
  font-size: 0.72rem;
}

.core-icon-detail {
  width: clamp(96px, 13vw, 132px);
  height: clamp(96px, 13vw, 132px);
  border-radius: 27px;
  font-size: clamp(1.55rem, 3vw, 2.15rem);
}

:global([data-theme="dark"]) .core-icon {
  border-color: hsl(var(--core-icon-hue) 28% 35%);
  background: hsl(var(--core-icon-hue) 28% 20%);
  color: hsl(var(--core-icon-hue) 55% 78%);
}
</style>
