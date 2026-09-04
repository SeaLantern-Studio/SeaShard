<script setup lang="ts">
import type { UiAcrylicBlurLevel, UiAppearanceSettings, UiThemeMode } from "@seashard/ui-sdk";
import { Cmz_Card, Cmz_Select, Cmz_Switch } from "cmzya-modern-ui";
import { ref } from "vue";
import BackgroundSettings from "./BackgroundSettings.vue";

const props = defineProps<{
  settings: Readonly<UiAppearanceSettings>;
  supportsAcrylic: boolean;
}>();

const emit = defineEmits<{
  change: [patch: Partial<UiAppearanceSettings>];
}>();

const backgroundExpanded = ref(false);
const themeOptions: Array<{ label: string; value: UiThemeMode }> = [
  { label: "跟随系统", value: "auto" },
  { label: "浅色", value: "light" },
  { label: "深色", value: "dark" },
];
const fontOptions = [
  { label: "系统默认", value: "" },
  { label: "Microsoft YaHei", value: '"Microsoft YaHei", sans-serif' },
  { label: "Segoe UI", value: '"Segoe UI", sans-serif' },
  { label: "Inter", value: "Inter, sans-serif" },
  { label: "JetBrains Mono", value: '"JetBrains Mono", monospace' },
];
const acrylicBlurOptions: Array<{ label: string; value: UiAcrylicBlurLevel }> = [
  { label: "关", value: "off" },
  { label: "低", value: "low" },
  { label: "中", value: "medium" },
  { label: "高", value: "high" },
];

function updateTheme(value: string | number): void {
  if (typeof value === "string" && themeOptions.some((option) => option.value === value)) {
    emit("change", { theme: value as UiThemeMode });
  }
}

function updateFont(value: string | number): void {
  if (typeof value === "string") emit("change", { fontFamily: value });
}

function updateBlur(value: string | number): void {
  if (typeof value === "string" && acrylicBlurOptions.some((option) => option.value === value)) {
    emit("change", { acrylicBlurLevel: value as UiAcrylicBlurLevel });
  }
}

function updateFontSize(event: Event): void {
  emit("change", { fontSize: Number.parseInt((event.target as HTMLInputElement).value, 10) });
}
</script>

<template>
  <Cmz_Card title="外观" subtitle="自定义软件背景和视觉效果">
    <div class="sl-settings-group">
      <div class="settings-entry">
        <div class="settings-entry-info">
          <span class="settings-entry-title">主题模式</span>
          <span class="settings-entry-desc">
            选择应用的主题外观，“跟随系统”会自动匹配系统的深色/浅色模式
          </span>
        </div>
        <div class="sl-input-md">
          <Cmz_Select
            :model-value="props.settings.theme"
            :options="themeOptions"
            @update:model-value="updateTheme"
          />
        </div>
      </div>

      <div class="settings-entry">
        <div class="settings-entry-info">
          <span class="settings-entry-title">文本大小</span>
          <span class="settings-entry-desc">调整界面文本的大小</span>
        </div>
        <div class="sl-slider-control">
          <input
            class="sl-slider"
            type="range"
            min="12"
            max="24"
            step="1"
            :value="props.settings.fontSize"
            @input="updateFontSize"
          />
          <span class="sl-slider-value">{{ props.settings.fontSize }}px</span>
        </div>
      </div>

      <div class="settings-entry">
        <div class="settings-entry-info">
          <span class="settings-entry-title">字体</span>
          <span class="settings-entry-desc">选择界面使用的字体，部分字体需要系统已安装</span>
        </div>
        <div class="sl-input-lg">
          <Cmz_Select
            :model-value="props.settings.fontFamily"
            :options="fontOptions"
            :searchable="true"
            :preview-font="true"
            placeholder="搜索字体"
            @update:model-value="updateFont"
          />
        </div>
      </div>

      <template v-if="props.supportsAcrylic">
        <div class="settings-entry">
          <div class="settings-entry-info">
            <span class="settings-entry-title">高级材质</span>
            <span class="settings-entry-desc">开启半透明材质和窗口融合效果</span>
          </div>
          <Cmz_Switch
            :model-value="props.settings.acrylicEnabled"
            @update:model-value="emit('change', { acrylicEnabled: $event })"
          />
        </div>

        <div v-if="props.settings.acrylicEnabled" class="settings-entry">
          <div class="settings-entry-info">
            <span class="settings-entry-title">亚克力模糊强度</span>
            <span class="settings-entry-desc">调整高级材质的背景模糊</span>
          </div>
          <div class="sl-input-md">
            <Cmz_Select
              :model-value="props.settings.acrylicBlurLevel"
              :options="acrylicBlurOptions"
              @update:model-value="updateBlur"
            />
          </div>
        </div>
      </template>

      <div class="settings-entry">
        <div class="settings-entry-info">
          <span class="settings-entry-title">极简模式</span>
          <span class="settings-entry-desc">关闭界面动画和过渡效果</span>
        </div>
        <Cmz_Switch
          :model-value="props.settings.minimalMode"
          @update:model-value="emit('change', { minimalMode: $event })"
        />
      </div>

      <BackgroundSettings
        :settings="props.settings"
        :expanded="backgroundExpanded"
        @update:expanded="backgroundExpanded = $event"
        @change="emit('change', $event)"
      />
    </div>
  </Cmz_Card>
</template>

<style scoped>
.sl-settings-group {
  display: flex;
  flex-direction: column;
}

.settings-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sl-space-md);
  padding: var(--sl-space-sm) 0;
  border-bottom: 1px solid var(--sl-border-light);
}

.settings-entry:last-of-type {
  border-bottom: none;
}

.settings-entry-info {
  flex: 1;
  min-width: 0;
}

.settings-entry-title {
  display: block;
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--sl-text-primary);
}

.settings-entry-desc {
  display: block;
  font-size: 0.8125rem;
  color: var(--sl-text-tertiary);
  line-height: 1.4;
  margin-top: 2px;
}

.sl-input-md {
  width: 200px;
  flex-shrink: 0;
}

.sl-input-lg {
  width: 320px;
  flex-shrink: 0;
}

.sl-slider-control {
  display: flex;
  align-items: center;
  gap: var(--sl-space-md);
  flex-shrink: 0;
  min-width: 240px;
  max-width: 320px;
}

.sl-slider {
  flex: 1;
  height: 6px;
  border-radius: var(--sl-radius-full);
  background: var(--sl-border);
  outline: none;
  appearance: none;
}

.sl-slider::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--sl-primary);
  cursor: pointer;
  transition: all var(--sl-transition-fast);
}

.sl-slider::-webkit-slider-thumb:hover {
  transform: scale(1.2);
  box-shadow: 0 0 0 4px var(--sl-primary-bg);
}

.sl-slider-value {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--sl-text-primary);
  min-width: 50px;
  text-align: right;
}
</style>
