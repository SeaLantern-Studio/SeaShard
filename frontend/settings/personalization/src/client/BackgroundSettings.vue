<script setup lang="ts">
import type { UiAppearanceSettings, UiBackgroundSize } from "@seashard/ui-sdk";
import { Cmz_Button, Cmz_Select } from "cmzya-modern-ui";
import { ChevronDown } from "lucide-vue-next";
import { ref } from "vue";

const props = defineProps<{
  settings: Readonly<UiAppearanceSettings>;
  expanded: boolean;
}>();

const emit = defineEmits<{
  "update:expanded": [value: boolean];
  change: [patch: Partial<UiAppearanceSettings>];
}>();

const fileInput = ref<HTMLInputElement>();
const backgroundSizeOptions: Array<{ label: string; value: UiBackgroundSize }> = [
  { label: "覆盖 (Cover)", value: "cover" },
  { label: "包含 (Contain)", value: "contain" },
  { label: "拉伸 (Fill)", value: "fill" },
  { label: "原始大小 (Auto)", value: "auto" },
];

type NumericAppearanceKey = "backgroundOpacity" | "backgroundBlur" | "backgroundBrightness";

function updateNumber(key: NumericAppearanceKey, event: Event): void {
  const value = Number.parseFloat((event.target as HTMLInputElement).value);
  emit("change", { [key]: value });
}

function handleBackgroundSize(value: string | number): void {
  if (typeof value === "string" && backgroundSizeOptions.some((option) => option.value === value)) {
    emit("change", { backgroundSize: value as UiBackgroundSize });
  }
}

function pickImage(): void {
  fileInput.value?.click();
}

async function handleImage(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  emit("change", { backgroundImage: await readDataUrl(file) });
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")), { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("图片读取失败")), {
      once: true,
    });
    reader.readAsDataURL(file);
  });
}
</script>

<template>
  <div class="collapsible-section">
    <button
      type="button"
      class="collapsible-header"
      :aria-expanded="props.expanded"
      @click="emit('update:expanded', !props.expanded)"
    >
      <div class="setting-info">
        <span class="setting-label">背景图片</span>
        <span class="setting-desc">上传一张图片作为软件背景，支持 PNG、JPG、WEBP 等格式</span>
      </div>
      <span class="collapsible-toggle" :class="{ expanded: props.expanded }">
        <ChevronDown :size="20" />
      </span>
    </button>

    <Transition name="collapse">
      <div v-show="props.expanded" class="collapsible-content">
        <div class="setting-row full-width">
          <div class="bg-image-picker">
            <div v-if="props.settings.backgroundImage" class="bg-preview">
              <img :src="props.settings.backgroundImage" alt="背景预览" />
              <div class="bg-preview-overlay">
                <span class="bg-preview-path">自定义背景</span>
                <Cmz_Button
                  variant="solid"
                  color="#ef4444"
                  size="sm"
                  @click="emit('change', { backgroundImage: '' })"
                >
                  移除
                </Cmz_Button>
              </div>
            </div>
            <Cmz_Button v-else variant="outline" @click="pickImage">选择图片</Cmz_Button>
            <Cmz_Button
              v-if="props.settings.backgroundImage"
              variant="outline"
              size="sm"
              @click="pickImage"
            >
              更换图片
            </Cmz_Button>
            <input
              ref="fileInput"
              class="file-input"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              @change="handleImage"
            />
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">不透明度</span>
            <span class="setting-desc">调节背景图片的不透明度 (0.0 - 1.0)</span>
          </div>
          <div class="slider-control">
            <input
              class="sl-slider"
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="props.settings.backgroundOpacity"
              @input="updateNumber('backgroundOpacity', $event)"
            />
            <span class="slider-value">{{ props.settings.backgroundOpacity }}</span>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">模糊程度 (px)</span>
            <span class="setting-desc">为背景添加模糊效果，让前景内容更清晰</span>
          </div>
          <div class="slider-control">
            <input
              class="sl-slider"
              type="range"
              min="0"
              max="20"
              step="1"
              :value="props.settings.backgroundBlur"
              @input="updateNumber('backgroundBlur', $event)"
            />
            <span class="slider-value">{{ props.settings.backgroundBlur }}px</span>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">亮度</span>
            <span class="setting-desc">调节背景图片亮度，1.0 为原始亮度</span>
          </div>
          <div class="slider-control">
            <input
              class="sl-slider"
              type="range"
              min="0"
              max="2"
              step="0.1"
              :value="props.settings.backgroundBrightness"
              @input="updateNumber('backgroundBrightness', $event)"
            />
            <span class="slider-value">{{ props.settings.backgroundBrightness }}</span>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">图片填充方式</span>
            <span class="setting-desc">选择背景图片的显示方式</span>
          </div>
          <div class="input-lg">
            <Cmz_Select
              :model-value="props.settings.backgroundSize"
              :options="backgroundSizeOptions"
              @update:model-value="handleBackgroundSize"
            />
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.collapsible-section {
  border: 1px solid var(--sl-border-light);
  border-radius: var(--sl-radius-md);
  overflow: hidden;
  margin: var(--sl-space-sm) 0;
}

.collapsible-header {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  padding: var(--sl-space-md);
  cursor: pointer;
  background: var(--sl-surface);
  transition: background-color var(--sl-transition-fast);
  text-align: left;
}

.collapsible-header:hover {
  background: var(--sl-surface-hover);
}

.collapsible-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--sl-radius-sm);
  color: var(--sl-text-secondary);
  transition: all var(--sl-transition-normal);
  flex-shrink: 0;
}

.collapsible-toggle.expanded {
  transform: rotate(180deg);
}

.collapsible-content {
  padding: 0 var(--sl-space-md) var(--sl-space-md);
  background: var(--sl-surface);
}

.collapse-enter-active,
.collapse-leave-active {
  transition: all 0.3s ease;
  overflow: hidden;
}

.collapse-enter-from,
.collapse-leave-to {
  opacity: 0;
  max-height: 0;
}

.collapse-enter-to,
.collapse-leave-from {
  opacity: 1;
  max-height: 800px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sl-space-md) 0;
  border-bottom: 1px solid var(--sl-border-light);
  gap: var(--sl-space-lg);
}

.setting-row:last-child {
  border-bottom: none;
}

.setting-row.full-width {
  flex-direction: column;
  align-items: stretch;
}

.setting-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.setting-label {
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--sl-text-primary);
}

.setting-desc {
  font-size: 0.8125rem;
  color: var(--sl-text-tertiary);
  line-height: 1.4;
}

.input-lg {
  width: 320px;
  flex-shrink: 0;
}

.bg-image-picker {
  display: flex;
  flex-direction: column;
  gap: var(--sl-space-sm);
  margin-top: var(--sl-space-sm);
}

.bg-preview {
  position: relative;
  width: 100%;
  max-width: 400px;
  height: 200px;
  border-radius: var(--sl-radius-md);
  overflow: hidden;
  border: 1px solid var(--sl-border);
}

.bg-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bg-preview-overlay {
  position: absolute;
  inset: auto 0 0;
  padding: var(--sl-space-sm) var(--sl-space-md);
  background: linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sl-space-sm);
}

.bg-preview-path {
  font-size: 0.8125rem;
  color: white;
  font-family: var(--sl-font-mono);
}

.slider-control {
  display: flex;
  align-items: center;
  gap: var(--sl-space-md);
  min-width: 200px;
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

.slider-value {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--sl-text-primary);
  min-width: 50px;
  text-align: right;
}

.file-input {
  display: none;
}
</style>
