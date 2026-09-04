<script setup lang="ts">
import type { UiAppearanceService, UiAppearanceSettings, UiColorThemeId } from "@seashard/ui-sdk";
import AppearanceCard from "./AppearanceCard.vue";
import ColorThemeCard from "./ColorThemeCard.vue";

const props = defineProps<{
  appearance: UiAppearanceService;
}>();

const settings = props.appearance.settings;

function updateColor(color: UiColorThemeId): void {
  props.appearance.update({ color });
}

function updateAppearance(patch: Partial<UiAppearanceSettings>): void {
  props.appearance.update(patch);
}
</script>

<template>
  <div class="settings-view animate-stagger-in">
    <ColorThemeCard :color="settings.color" @change="updateColor" />
    <AppearanceCard
      :settings="settings"
      :supports-acrylic="appearance.supportsAcrylic !== false"
      @change="updateAppearance"
    />
  </div>
</template>

<style scoped>
.settings-view {
  display: flex;
  flex-direction: column;
  gap: var(--sl-space-lg);
  max-width: 860px;
  margin: 0 auto;
  padding-bottom: var(--sl-space-2xl);
}
</style>
