<script setup lang="ts">
import DownloadSettingsCard from "./DownloadSettingsCard.vue";

const props = defineProps<{
  selectDirectory: () => Promise<string | undefined>;
}>();
</script>

<template>
  <div class="settings-view animate-stagger-in">
    <DownloadSettingsCard :select-directory="props.selectDirectory" />
  </div>
</template>

<style scoped>
.settings-view {
  display: flex;
  max-width: 860px;
  flex-direction: column;
  gap: var(--sl-space-lg);
  margin: 0 auto;
  padding-bottom: var(--sl-space-2xl);
}
</style>
