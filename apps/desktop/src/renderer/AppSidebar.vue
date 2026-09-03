<script setup lang="ts">
import {
  ApplicationSidebar,
  type SettingsMode,
  type WorkspaceMode,
} from "@seashard/application-shell";

const props = defineProps<{
  workspace: WorkspaceMode;
  settingsMode?: SettingsMode;
  downloadMode: boolean;
}>();
</script>

<template>
  <ApplicationSidebar
    :workspace="props.workspace"
    :settings-mode="props.settingsMode"
    :download-mode="props.downloadMode"
  />
</template>
