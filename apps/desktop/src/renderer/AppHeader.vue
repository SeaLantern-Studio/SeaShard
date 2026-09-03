<script setup lang="ts">
import type { DesktopHostConnectionsSnapshot } from "@seashard/contracts";
import {
  ApplicationHeader,
  appearanceService,
  type ApplicationHeaderHostIndicator,
  type SettingsMode,
  type WorkspaceMode,
} from "@seashard/application-shell";
import { computed, ref } from "vue";
import DownloadTaskPill from "./DownloadTaskPill.vue";

const props = defineProps<{
  workspace: WorkspaceMode;
  settingsMode?: SettingsMode;
  rightPanelOpen: boolean;
  hostConnections?: DesktopHostConnectionsSnapshot;
}>();
const emit = defineEmits<{
  "update:workspace": [value: WorkspaceMode];
  "toggle-right-panel": [];
}>();
const isMaximized = ref(false);
const currentTheme = computed(() => appearanceService.settings.value.theme);
const hostIndicator = computed<ApplicationHeaderHostIndicator | undefined>(() => {
  const snapshot = props.hostConnections;
  if (!snapshot) return undefined;
  const hosts = snapshot.hosts;
  const online = hosts.filter(
    (host) => host.state === "control" || host.state === "read-only",
  ).length;
  const hasError = hosts.some((host) => host.state === "error" || host.state === "disconnected");
  const hasAttention = hosts.some((host) => host.state === "read-only" || Boolean(host.pending));
  const label =
    hosts.length > 1
      ? `${online}/${hosts.length} Host`
      : hosts[0]?.pending
        ? "Host 控制请求"
        : hosts[0]?.state === "read-only"
          ? "本机 Host · 只读"
          : hosts[0]?.state === "connecting"
            ? "Host 连接中"
            : hasError
              ? "Host 未连接"
              : "Host";
  return {
    label,
    state: hasError ? "error" : hasAttention ? "attention" : "connected",
  };
});

async function minimizeWindow(): Promise<void> {
  await window.seashard.window.minimize();
}

async function toggleMaximize(): Promise<void> {
  isMaximized.value = await window.seashard.window.toggleMaximize();
}

async function closeWindow(): Promise<void> {
  await window.seashard.window.close();
}
</script>

<template>
  <ApplicationHeader
    :workspace="props.workspace"
    :settings-mode="props.settingsMode"
    :theme="currentTheme"
    :right-panel-open="props.rightPanelOpen"
    :host-indicator="hostIndicator"
    :show-window-controls="true"
    :maximized="isMaximized"
    @update:workspace="emit('update:workspace', $event)"
    @update:theme="appearanceService.update({ theme: $event })"
    @toggle-right-panel="emit('toggle-right-panel')"
    @minimize="minimizeWindow"
    @maximize="toggleMaximize"
    @close="closeWindow"
  >
    <template #before-host>
      <DownloadTaskPill />
    </template>
  </ApplicationHeader>
</template>
