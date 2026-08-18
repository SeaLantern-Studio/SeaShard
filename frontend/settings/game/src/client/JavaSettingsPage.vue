<script setup lang="ts">
import type { JavaInstallationSnapshot, JavaRuntimeClientService } from "@seashard/contracts";
import { Cmz_Button, Cmz_Card } from "cmzya-modern-ui";
import { Check, Coffee, Plus, Search, WandSparkles } from "lucide-vue-next";
import { computed, onMounted, ref } from "vue";

const props = defineProps<{
  javaRuntime: JavaRuntimeClientService;
}>();

type OperationTone = "neutral" | "success" | "error";

// 自动扫描与手动添加分开保存，重新扫描时不会丢失当前会话中手动选择的 Java。
const scannedJavaInstallations = ref<readonly JavaInstallationSnapshot[]>([]);
const manuallyAddedJavaInstallations = ref<readonly JavaInstallationSnapshot[]>([]);
const selectedJavaId = ref("auto");
const scanning = ref(false);
const adding = ref(false);
const operationMessage = ref("自动选择，或使用电脑上检测到的 Java");
const operationTone = ref<OperationTone>("neutral");
const busy = computed(() => scanning.value || adding.value);
const detectedJavaInstallations = computed(() => {
  const installations = new Map<string, JavaInstallationSnapshot>();
  for (const installation of scannedJavaInstallations.value) {
    installations.set(installation.id, installation);
  }
  for (const installation of manuallyAddedJavaInstallations.value) {
    installations.set(installation.id, installation);
  }
  return [...installations.values()].sort(
    (left, right) =>
      right.majorVersion - left.majorVersion ||
      left.vendor.localeCompare(right.vendor) ||
      left.path.localeCompare(right.path),
  );
});

function reportOperation(message: string, tone: OperationTone): void {
  operationMessage.value = message;
  operationTone.value = tone;
}

async function scanJavaInstallations(): Promise<void> {
  if (busy.value) return;
  scanning.value = true;
  reportOperation("正在扫描 Java 运行环境…", "neutral");
  try {
    const installations = await props.javaRuntime.scan();
    scannedJavaInstallations.value = installations;
    reportOperation(`扫描完成，发现 ${installations.length} 个 Java 运行环境`, "success");
  } catch (error) {
    reportOperation(
      `Java 扫描失败：${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  } finally {
    scanning.value = false;
  }
}

async function addJavaInstallation(): Promise<void> {
  if (busy.value) return;
  adding.value = true;
  reportOperation("请选择 Java 安装目录中的 bin/java.exe", "neutral");
  try {
    const installation = await props.javaRuntime.add();
    if (!installation) {
      reportOperation("已取消添加 Java", "neutral");
      return;
    }
    manuallyAddedJavaInstallations.value = [
      ...manuallyAddedJavaInstallations.value.filter(
        (candidate) => candidate.id !== installation.id,
      ),
      installation,
    ];
    selectedJavaId.value = installation.id;
    reportOperation(`已添加 Java ${installation.version} · ${installation.vendor}`, "success");
  } catch (error) {
    reportOperation(
      `Java 添加失败：${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  } finally {
    adding.value = false;
  }
}

onMounted(() => void scanJavaInstallations());
</script>

<template>
  <div class="java-settings-view animate-stagger-in">
    <Cmz_Card title="Java" subtitle="选择 Minecraft 实例默认使用的 Java 运行环境">
      <div class="java-list-toolbar">
        <div>
          <h3 class="java-list-title">Java 版本</h3>
          <p
            class="java-list-subtitle"
            :class="`java-list-subtitle--${operationTone}`"
            role="status"
            aria-live="polite"
          >
            {{ operationMessage }}
          </p>
        </div>
        <div class="java-toolbar-actions">
          <Cmz_Button
            variant="outline"
            size="sm"
            :loading="scanning"
            :disabled="busy"
            @click="scanJavaInstallations"
          >
            <Search :size="16" :stroke-width="1.8" />
            扫描
          </Cmz_Button>
          <Cmz_Button
            variant="outline"
            size="sm"
            :loading="adding"
            :disabled="busy"
            @click="addJavaInstallation"
          >
            <Plus :size="16" :stroke-width="1.8" />
            添加
          </Cmz_Button>
        </div>
      </div>

      <div class="java-list" role="radiogroup" aria-label="Java 版本">
        <button
          type="button"
          class="java-option"
          :class="{ selected: selectedJavaId === 'auto' }"
          role="radio"
          :aria-checked="selectedJavaId === 'auto'"
          @click="selectedJavaId = 'auto'"
        >
          <span class="java-option-icon" aria-hidden="true">
            <WandSparkles :size="20" :stroke-width="1.8" />
          </span>
          <span class="java-option-copy">
            <span class="java-option-name">自动选择</span>
            <span class="java-option-detail">根据游戏版本自动匹配可用的 Java</span>
          </span>
          <span class="java-option-check" aria-hidden="true">
            <Check v-if="selectedJavaId === 'auto'" :size="17" :stroke-width="2" />
          </span>
        </button>

        <button
          v-for="installation in detectedJavaInstallations"
          :key="installation.id"
          type="button"
          class="java-option"
          :class="{ selected: selectedJavaId === installation.id }"
          role="radio"
          :aria-checked="selectedJavaId === installation.id"
          :title="installation.path"
          @click="selectedJavaId = installation.id"
        >
          <span class="java-option-icon" aria-hidden="true">
            <Coffee :size="20" :stroke-width="1.8" />
          </span>
          <span class="java-option-copy">
            <span class="java-option-name">Java {{ installation.version }}</span>
            <span class="java-option-detail">
              {{ installation.vendor }} · {{ installation.architecture }} · {{ installation.path }}
            </span>
          </span>
          <span class="java-option-check" aria-hidden="true">
            <Check v-if="selectedJavaId === installation.id" :size="17" :stroke-width="2" />
          </span>
        </button>
      </div>
    </Cmz_Card>
  </div>
</template>

<style scoped>
.java-settings-view {
  max-width: 860px;
  margin: 0 auto;
  padding-bottom: var(--sl-space-2xl);
}

.java-list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sl-space-lg);
  padding-bottom: var(--sl-space-md);
}

.java-list-title,
.java-list-subtitle {
  margin: 0;
}

.java-list-title {
  color: var(--sl-text-primary);
  font-size: 0.9375rem;
  font-weight: 600;
}

.java-list-subtitle {
  margin-top: 3px;
  color: var(--sl-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.4;
}
.java-toolbar-actions {
  display: flex;
  align-items: center;
  gap: var(--sl-space-sm);
}

.java-list-subtitle--success {
  color: var(--sl-success);
}

.java-list-subtitle--error {
  color: var(--sl-error);
}

.java-list {
  display: flex;
  flex-direction: column;
  gap: var(--sl-space-sm);
}

.java-option {
  display: grid;
  width: 100%;
  min-height: 64px;
  grid-template-columns: 38px minmax(0, 1fr) 24px;
  align-items: center;
  gap: var(--sl-space-md);
  padding: 10px 14px;
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius-md);
  background: var(--sl-surface);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--sl-transition-fast),
    background var(--sl-transition-fast),
    transform var(--sl-transition-fast);
}

.java-option:hover {
  border-color: var(--sl-primary-light);
  background: var(--sl-surface-hover);
}

.java-option:active {
  transform: scale(0.99);
}

.java-option:focus-visible {
  outline: 2px solid var(--sl-primary);
  outline-offset: 2px;
}

.java-option.selected {
  border-color: var(--sl-primary);
  background: var(--sl-primary-bg);
}

.java-option-icon {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: var(--sl-radius-sm);
  background: var(--sl-bg-secondary);
  color: var(--sl-text-secondary);
}

.java-option.selected .java-option-icon,
.java-option-check {
  color: var(--sl-primary);
}

.java-option-copy {
  display: block;
  min-width: 0;
}

.java-option-name,
.java-option-detail {
  display: block;
}

.java-option-name {
  color: var(--sl-text-primary);
  font-size: 0.9375rem;
  font-weight: 500;
}

.java-option-detail {
  overflow: hidden;
  width: 107.527%;
  margin-top: 2px;
  color: var(--sl-text-tertiary);
  font-family: var(--sl-font-sans);
  font-size: 0.875rem;
  font-weight: 400;
  letter-spacing: 0.005em;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
  transform: scale(0.93);
  transform-origin: left top;
}

.java-option-check {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
}

@media (max-width: 680px) {
  .java-list-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .java-option {
    grid-template-columns: 34px minmax(0, 1fr) 20px;
    gap: var(--sl-space-sm);
    padding-inline: 10px;
  }
}
</style>
