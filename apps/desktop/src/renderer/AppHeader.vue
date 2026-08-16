<script setup lang="ts">
import type { UiThemeMode } from "@seashard/ui-sdk";
import {
  Bot,
  Copy,
  Gamepad2,
  Languages,
  Minus,
  Monitor,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Server,
  Square,
  Sun,
  X,
} from "lucide-vue-next";
import { computed, ref } from "vue";
import { appearanceService } from "./appearance";
import type { WorkspaceMode } from "./workspace-layout";

const props = defineProps<{
  workspace: WorkspaceMode;
  settingsMode: boolean;
  rightPanelOpen: boolean;
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
      <div v-if="props.settingsMode" class="settings-header-title">设置</div>
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

      <button
        v-if="!props.settingsMode"
        type="button"
        class="panel-toggle"
        :class="{ active: props.rightPanelOpen }"
        :title="props.rightPanelOpen ? '收起右侧栏' : '展开右侧栏'"
        :aria-label="props.rightPanelOpen ? '收起右侧栏' : '展开右侧栏'"
        :aria-pressed="props.rightPanelOpen"
        @click="emit('toggle-right-panel')"
      >
        <PanelRightClose v-if="props.rightPanelOpen" :size="17" :stroke-width="1.8" />
        <PanelRightOpen v-else :size="17" :stroke-width="1.8" />
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
