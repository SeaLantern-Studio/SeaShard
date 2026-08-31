<script setup lang="ts">
import type { DesktopHostConnectionsSnapshot } from "@seashard/contracts";
import type { UiThemeMode } from "@seashard/ui-sdk";
import {
  Bot,
  Copy,
  Gamepad2,
  Languages,
  Minus,
  Monitor,
  Moon,
  Network,
  Server,
  Square,
  Sun,
  X,
} from "lucide-vue-next";
import { computed, ref } from "vue";
import { shouldShowHostChrome } from "./host-connections";
import { appearanceService } from "./appearance";
import DownloadTaskPill from "./DownloadTaskPill.vue";
import type { SettingsMode, WorkspaceMode } from "./workspace-layout";

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
const themeIndicatorOffset = computed(() => {
  const themeOrder: UiThemeMode[] = ["auto", "light", "dark"];
  return themeOrder.indexOf(currentTheme.value) * 26;
});
const hostIndicator = computed(() => {
  const snapshot = props.hostConnections;
  if (!snapshot) return undefined;
  const hosts = snapshot.hosts;
  const visible = shouldShowHostChrome(snapshot);
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

function setTheme(theme: UiThemeMode): void {
  appearanceService.update({ theme });
}

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
  <header class="app-header">
    <div class="header-workspace">
      <div v-if="props.settingsMode" class="settings-header-title">
        {{ props.settingsMode === "agent" ? "Agent 设置" : "设置" }}
      </div>
      <div
        v-else
        class="workspace-switcher"
        role="tablist"
        aria-label="工作区"
        :data-workspace="props.workspace"
      >
        <div class="workspace-mode-indicator" aria-hidden="true"></div>
        <button
          type="button"
          role="tab"
          class="workspace-mode-btn"
          :class="{ active: props.workspace === 'agent' }"
          :aria-selected="props.workspace === 'agent'"
          @click="emit('update:workspace', 'agent')"
        >
          <Bot :size="15" :stroke-width="1.8" />
          <span>Agent</span>
        </button>
        <button
          type="button"
          role="tab"
          class="workspace-mode-btn"
          :class="{ active: props.workspace === 'server' }"
          :aria-selected="props.workspace === 'server'"
          @click="emit('update:workspace', 'server')"
        >
          <Server :size="15" :stroke-width="1.8" />
          <span>服务器</span>
        </button>
        <button
          type="button"
          role="tab"
          class="workspace-mode-btn"
          :class="{ active: props.workspace === 'launcher' }"
          :aria-selected="props.workspace === 'launcher'"
          @click="emit('update:workspace', 'launcher')"
        >
          <Gamepad2 :size="15" :stroke-width="1.8" />
          <span>启动器</span>
        </button>
      </div>
    </div>

    <div class="header-right">
      <div class="language-selector">
        <button type="button" class="language-button" title="语言" aria-label="语言">
          <Languages :size="16" />
        </button>
      </div>

      <div class="theme-switcher" aria-label="主题">
        <div
          class="theme-indicator"
          :style="{ transform: `translateX(${themeIndicatorOffset}px)` }"
        ></div>
        <button
          type="button"
          class="theme-btn"
          :class="{ active: currentTheme === 'auto' }"
          title="跟随系统"
          @click="setTheme('auto')"
        >
          <Monitor :size="16" />
        </button>
        <button
          type="button"
          class="theme-btn"
          :class="{ active: currentTheme === 'light' }"
          title="浅色"
          @click="setTheme('light')"
        >
          <Sun :size="16" />
        </button>
        <button
          type="button"
          class="theme-btn"
          :class="{ active: currentTheme === 'dark' }"
          title="深色"
          @click="setTheme('dark')"
        >
          <Moon :size="16" />
        </button>
      </div>

      <DownloadTaskPill />

      <button
        v-if="!props.settingsMode && hostIndicator"
        type="button"
        class="host-indicator"
        :class="{ active: props.rightPanelOpen }"
        :data-state="hostIndicator.state"
        :title="props.rightPanelOpen ? '收起 Host 状态' : '查看 Host 状态'"
        :aria-label="props.rightPanelOpen ? '收起 Host 状态' : '查看 Host 状态'"
        :aria-pressed="props.rightPanelOpen"
        @click="emit('toggle-right-panel')"
      >
        <Network :size="15" :stroke-width="1.9" />
        <span>{{ hostIndicator.label }}</span>
      </button>

      <div class="window-controls">
        <button type="button" class="win-btn" title="最小化" @click="minimizeWindow">
          <Minus :size="12" />
        </button>
        <button
          type="button"
          class="win-btn"
          :title="isMaximized ? '还原' : '最大化'"
          @click="toggleMaximize"
        >
          <Copy v-if="isMaximized" :size="12" />
          <Square v-else :size="12" />
        </button>
        <button type="button" class="win-btn win-btn-close" title="关闭" @click="closeWindow">
          <X :size="12" />
        </button>
      </div>
    </div>
  </header>
</template>
