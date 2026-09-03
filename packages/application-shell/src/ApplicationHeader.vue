<script setup lang="ts">
import type { ApplicationHeaderHostIndicator } from "./types";
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
import { computed } from "vue";
import type { SettingsMode, WorkspaceMode } from "./workspace-layout";

const props = withDefaults(
  defineProps<{
    workspace: WorkspaceMode;
    settingsMode?: SettingsMode;
    workspaces?: readonly WorkspaceMode[];
    theme: UiThemeMode;
    rightPanelOpen?: boolean;
    hostIndicator?: ApplicationHeaderHostIndicator;
    showLanguage?: boolean;
    showWindowControls?: boolean;
    maximized?: boolean;
  }>(),
  {
    workspaces: () => ["agent", "server", "launcher"],
    settingsMode: undefined,
    rightPanelOpen: false,
    hostIndicator: undefined,
    showLanguage: true,
    showWindowControls: false,
    maximized: false,
  },
);

const emit = defineEmits<{
  "update:workspace": [value: WorkspaceMode];
  "update:theme": [value: UiThemeMode];
  "toggle-right-panel": [];
  minimize: [];
  maximize: [];
  close: [];
}>();

const workspaceDefinitions = [
  { value: "agent", label: "Agent", icon: Bot },
  { value: "server", label: "服务器", icon: Server },
  { value: "launcher", label: "启动器", icon: Gamepad2 },
] as const;
const themeDefinitions = [
  { value: "auto", label: "跟随系统", icon: Monitor },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
] as const;
const visibleWorkspaces = computed(() =>
  workspaceDefinitions.filter(({ value }) => props.workspaces.includes(value)),
);
const workspaceIndicatorStyle = computed(() => ({
  transform: `translateX(calc(var(--workspace-tab-step) * ${Math.max(
    0,
    visibleWorkspaces.value.findIndex(({ value }) => value === props.workspace),
  )}))`,
}));
const themeIndicatorOffset = computed(() => {
  const themeOrder: UiThemeMode[] = ["auto", "light", "dark"];
  return themeOrder.indexOf(props.theme) * 26;
});
</script>

<template>
  <header class="app-header">
    <div class="header-workspace">
      <div v-if="props.settingsMode" class="settings-header-title">
        {{
          props.settingsMode === "agent"
            ? "Agent 设置"
            : props.settingsMode === "server"
              ? "服务器设置"
              : "设置"
        }}
      </div>
      <div
        v-else
        class="workspace-switcher"
        role="tablist"
        aria-label="工作区"
        :data-workspace="props.workspace"
      >
        <div
          class="workspace-mode-indicator"
          :style="workspaceIndicatorStyle"
          aria-hidden="true"
        ></div>
        <button
          v-for="definition in visibleWorkspaces"
          :key="definition.value"
          type="button"
          role="tab"
          class="workspace-mode-btn"
          :class="{ active: props.workspace === definition.value }"
          :aria-selected="props.workspace === definition.value"
          @click="emit('update:workspace', definition.value)"
        >
          <component :is="definition.icon" :size="15" :stroke-width="1.8" />
          <span>{{ definition.label }}</span>
        </button>
      </div>
    </div>

    <div class="header-right">
      <div v-if="props.showLanguage" class="language-selector">
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
          v-for="themeMode in themeDefinitions"
          :key="themeMode.value"
          type="button"
          class="theme-btn"
          :class="{ active: props.theme === themeMode.value }"
          :title="themeMode.label"
          @click="emit('update:theme', themeMode.value)"
        >
          <component :is="themeMode.icon" :size="16" />
        </button>
      </div>

      <slot name="before-host"></slot>

      <button
        v-if="props.hostIndicator"
        type="button"
        class="host-indicator"
        :class="{ active: props.rightPanelOpen }"
        :data-state="props.hostIndicator.state"
        :title="props.rightPanelOpen ? '收起 Host 状态' : '查看 Host 状态'"
        :aria-label="props.rightPanelOpen ? '收起 Host 状态' : '查看 Host 状态'"
        :aria-pressed="props.rightPanelOpen"
        @click="emit('toggle-right-panel')"
      >
        <Network :size="15" :stroke-width="1.9" />
        <span>{{ props.hostIndicator.label }}</span>
      </button>

      <slot name="actions"></slot>

      <div v-if="props.showWindowControls" class="window-controls">
        <button type="button" class="win-btn" title="最小化" @click="emit('minimize')">
          <Minus :size="12" />
        </button>
        <button
          type="button"
          class="win-btn"
          :title="props.maximized ? '还原' : '最大化'"
          @click="emit('maximize')"
        >
          <Copy v-if="props.maximized" :size="12" />
          <Square v-else :size="12" />
        </button>
        <button type="button" class="win-btn win-btn-close" title="关闭" @click="emit('close')">
          <X :size="12" />
        </button>
      </div>
    </div>
  </header>
</template>
