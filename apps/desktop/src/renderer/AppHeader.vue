<script setup lang="ts">
import { Copy, Languages, Minus, Monitor, Moon, Square, Sun, X } from "lucide-vue-next";
import { computed, onMounted, onUnmounted, ref } from "vue";

type ThemePreference = "auto" | "light" | "dark";

const currentTheme = ref<ThemePreference>("auto");
const isMaximized = ref(false);
let systemTheme: MediaQueryList | undefined;

const themeIndicatorOffset = computed(() => {
  const themeOrder: ThemePreference[] = ["auto", "light", "dark"];
  return themeOrder.indexOf(currentTheme.value) * 26;
});

function applyTheme(theme: ThemePreference): void {
  const effectiveTheme = theme === "auto" ? (systemTheme?.matches ? "dark" : "light") : theme;
  document.documentElement.setAttribute("data-theme", effectiveTheme);
}

function setTheme(theme: ThemePreference): void {
  currentTheme.value = theme;
  applyTheme(theme);
}

function handleSystemThemeChange(): void {
  if (currentTheme.value === "auto") applyTheme("auto");
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

onMounted(() => {
  systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  systemTheme.addEventListener("change", handleSystemThemeChange);
  applyTheme(currentTheme.value);
});

onUnmounted(() => {
  systemTheme?.removeEventListener("change", handleSystemThemeChange);
});
</script>

<template>
  <header class="app-header">
    <div class="header-left">
      <h2 class="page-title">首页</h2>
    </div>

    <div class="header-center"></div>

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

      <div class="task-capsule">
        <div class="capsule-idle">
          <span class="status-dot"></span>
          <span class="status-text">SeaShard</span>
        </div>
      </div>

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
