<script setup lang="ts">
import type { UiColorThemeId } from "@seashard/ui-sdk";
import { Cmz_Card, Cmz_Select } from "cmzya-modern-ui";

const props = defineProps<{
  color: UiColorThemeId;
}>();

const emit = defineEmits<{
  change: [value: UiColorThemeId];
}>();

const colorOptions: Array<{ label: string; value: UiColorThemeId }> = [
  { label: "Default", value: "default" },
  { label: "Ocean", value: "ocean" },
  { label: "Rose", value: "rose" },
  { label: "Sunset", value: "sunset" },
  { label: "Midnight", value: "midnight" },
];

function handleColorChange(value: string | number): void {
  if (typeof value === "string" && colorOptions.some((option) => option.value === value)) {
    emit("change", value as UiColorThemeId);
  }
}
</script>

<template>
  <Cmz_Card>
    <template #header>
      <div class="color-theme-header">
        <div>
          <h3 class="card-title">颜色主题</h3>
          <p class="card-subtitle">自定义软件颜色主题</p>
        </div>
        <div class="sl-input-md">
          <Cmz_Select
            :model-value="props.color"
            :options="colorOptions"
            @update:model-value="handleColorChange"
          />
        </div>
      </div>
    </template>
  </Cmz_Card>
</template>

<style scoped>
.color-theme-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.card-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--sl-text-primary);
}

.card-subtitle {
  margin: var(--sl-space-xs) 0 0;
  font-size: 0.8125rem;
  color: var(--sl-text-tertiary);
}

.sl-input-md {
  width: 200px;
  flex-shrink: 0;
}
</style>
