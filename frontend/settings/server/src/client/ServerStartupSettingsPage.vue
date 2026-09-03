<script setup lang="ts">
import {
  serverJvmArgumentsMaximumLength,
  serverPortLimits,
  serverStartupDefaults,
  type ServerSettingsClientService,
  type ServerSettingsSnapshot,
  type ServerStartupDefaultsUpdate,
} from "@seashard/contracts";
import { Cmz_Button, Cmz_Card, Cmz_Input, Cmz_Switch, useToast } from "cmzya-modern-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{
  settings: ServerSettingsClientService;
}>();
const toast = useToast();

const minimumMemoryMiB = ref(String(serverStartupDefaults.minimumMemoryMiB));
const maximumMemoryMiB = ref(String(serverStartupDefaults.maximumMemoryMiB));
const serverPort = ref(String(serverStartupDefaults.port));
const autoAcceptEula = ref<boolean>(serverStartupDefaults.autoAcceptEula);
const jvmArguments = ref<string>(serverStartupDefaults.jvmArguments);
const baseline = ref<ServerStartupDefaultsUpdate>();
const loading = ref(true);
const saving = ref(false);
let disposed = false;

const dirty = computed(() => {
  const current = baseline.value;
  return (
    current !== undefined &&
    (minimumMemoryMiB.value !== String(current.defaultMinimumMemoryMiB) ||
      maximumMemoryMiB.value !== String(current.defaultMaximumMemoryMiB) ||
      serverPort.value !== String(current.defaultServerPort) ||
      autoAcceptEula.value !== current.autoAcceptEula ||
      jvmArguments.value !== current.defaultJvmArguments)
  );
});

onMounted(async () => {
  try {
    applySnapshot(await props.settings.get());
  } catch (error) {
    if (!disposed) {
      toast.error({ title: "读取启动设置失败", description: errorMessage(error) });
    }
  } finally {
    if (!disposed) loading.value = false;
  }
});

onBeforeUnmount(() => {
  disposed = true;
});

function applySnapshot(snapshot: ServerSettingsSnapshot): void {
  if (disposed) return;
  minimumMemoryMiB.value = String(snapshot.defaultMinimumMemoryMiB);
  maximumMemoryMiB.value = String(snapshot.defaultMaximumMemoryMiB);
  serverPort.value = String(snapshot.defaultServerPort);
  autoAcceptEula.value = snapshot.autoAcceptEula;
  jvmArguments.value = snapshot.defaultJvmArguments;
  baseline.value = {
    defaultMinimumMemoryMiB: snapshot.defaultMinimumMemoryMiB,
    defaultMaximumMemoryMiB: snapshot.defaultMaximumMemoryMiB,
    defaultServerPort: snapshot.defaultServerPort,
    autoAcceptEula: snapshot.autoAcceptEula,
    defaultJvmArguments: snapshot.defaultJvmArguments,
  };
}

function updateText(target: "minimum" | "maximum" | "port" | "jvm", value: string | number): void {
  const text = String(value);
  if (target === "minimum") minimumMemoryMiB.value = text;
  if (target === "maximum") maximumMemoryMiB.value = text;
  if (target === "port") serverPort.value = text;
  if (target === "jvm") jvmArguments.value = text;
}

function updateJvmArguments(event: Event): void {
  if (event.target instanceof HTMLTextAreaElement) {
    updateText("jvm", event.target.value);
  }
}

function updateAutoAcceptEula(value: boolean): void {
  autoAcceptEula.value = value;
}

/** 内存上下限必须作为一个整体校验并保存，避免后端持久化非法的中间组合。 */
function createUpdate(): ServerStartupDefaultsUpdate {
  const minimum = parsePositiveInteger(minimumMemoryMiB.value, "默认最小内存");
  const maximum = parsePositiveInteger(maximumMemoryMiB.value, "默认最大内存");
  if (minimum > maximum) throw new Error("默认最小内存不能大于默认最大内存");

  const port = parsePositiveInteger(serverPort.value, "默认端口");
  if (port < serverPortLimits.minimum || port > serverPortLimits.maximum) {
    throw new Error(
      `默认端口必须在 ${serverPortLimits.minimum} 到 ${serverPortLimits.maximum} 之间`,
    );
  }
  if (jvmArguments.value.length > serverJvmArgumentsMaximumLength) {
    throw new Error(`默认 JVM 参数不能超过 ${serverJvmArgumentsMaximumLength} 个字符`);
  }

  return {
    defaultMinimumMemoryMiB: minimum,
    defaultMaximumMemoryMiB: maximum,
    defaultServerPort: port,
    autoAcceptEula: autoAcceptEula.value,
    defaultJvmArguments: jvmArguments.value,
  };
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label}必须是正整数`);
  }
  return parsed;
}

async function save(): Promise<void> {
  if (loading.value || saving.value || !baseline.value || !dirty.value) return;

  let update: ServerStartupDefaultsUpdate;
  try {
    update = createUpdate();
  } catch (error) {
    toast.error({ title: "启动设置校验失败", description: errorMessage(error) });
    return;
  }

  saving.value = true;
  try {
    applySnapshot(await props.settings.setStartupDefaults(update));
    if (!disposed) toast.success({ title: "启动设置已保存" });
  } catch (error) {
    if (!disposed) toast.error({ title: "保存启动设置失败", description: errorMessage(error) });
  } finally {
    if (!disposed) saving.value = false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <div class="settings-view animate-stagger-in">
    <Cmz_Card title="启动设置">
      <div class="settings-entry">
        <div class="settings-entry-info">
          <label class="settings-entry-title" for="default-maximum-memory">默认最大内存</label>
          <span class="settings-entry-desc">
            尚未固化设置的服务器首次启动时保存的最大堆内存，单位 MiB
          </span>
        </div>
        <div class="number-control">
          <Cmz_Input
            id="default-maximum-memory"
            type="number"
            :min="1"
            :step="1"
            :model-value="maximumMemoryMiB"
            :disabled="loading || saving"
            aria-label="默认最大内存"
            @update:model-value="updateText('maximum', $event)"
          />
          <span class="unit">MiB</span>
        </div>
      </div>

      <div class="settings-entry">
        <div class="settings-entry-info">
          <label class="settings-entry-title" for="default-minimum-memory">默认最小内存</label>
          <span class="settings-entry-desc">
            尚未固化设置的服务器首次启动时保存的初始堆内存，单位 MiB
          </span>
        </div>
        <div class="number-control">
          <Cmz_Input
            id="default-minimum-memory"
            type="number"
            :min="1"
            :step="1"
            :model-value="minimumMemoryMiB"
            :disabled="loading || saving"
            aria-label="默认最小内存"
            @update:model-value="updateText('minimum', $event)"
          />
          <span class="unit">MiB</span>
        </div>
      </div>

      <div class="settings-entry">
        <div class="settings-entry-info">
          <label class="settings-entry-title" for="default-server-port">默认服务器端口</label>
          <span class="settings-entry-desc">尚未固化设置的服务器首次启动时保存的监听端口</span>
        </div>
        <div class="number-control">
          <Cmz_Input
            id="default-server-port"
            type="number"
            :min="serverPortLimits.minimum"
            :max="serverPortLimits.maximum"
            :step="1"
            :model-value="serverPort"
            :disabled="loading || saving"
            aria-label="默认服务器端口"
            @update:model-value="updateText('port', $event)"
          />
        </div>
      </div>

      <div class="settings-entry">
        <div class="settings-entry-info">
          <span class="settings-entry-title">自动同意 EULA</span>
          <span class="settings-entry-desc">
            首次启动固化设置时写入 eula=true；开启即表示你同意 Mojang 的最终用户许可协议
          </span>
        </div>
        <Cmz_Switch
          :model-value="autoAcceptEula"
          :disabled="loading || saving"
          aria-label="自动同意 EULA"
          @update:model-value="updateAutoAcceptEula"
        />
      </div>

      <div class="jvm-entry">
        <label class="settings-entry-title" for="default-jvm-arguments">默认 JVM 参数</label>
        <span class="settings-entry-desc">首次启动时固化到实例的 JVM 参数；留空则不追加</span>
        <textarea
          id="default-jvm-arguments"
          class="jvm-textarea"
          :value="jvmArguments"
          :maxlength="serverJvmArgumentsMaximumLength"
          :disabled="loading || saving"
          :spellcheck="false"
          rows="4"
          placeholder="例如：-XX:+UseG1GC -XX:+ParallelRefProcEnabled"
          @input="updateJvmArguments"
        />
      </div>

      <div class="settings-actions">
        <span class="settings-status" aria-hidden="true"></span>
        <Cmz_Button
          size="sm"
          :loading="saving"
          :disabled="loading || !baseline || !dirty"
          @click="save"
        >
          保存设置
        </Cmz_Button>
      </div>
    </Cmz_Card>
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

.settings-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sl-space-lg);
  padding: var(--sl-space-sm) 0;
}

.settings-entry-info {
  min-width: 180px;
  flex: 1;
}

.settings-entry-title {
  display: block;
  color: var(--sl-text-primary);
  font-size: 0.9375rem;
  font-weight: 500;
}

.settings-entry-desc {
  display: block;
  margin-top: 2px;
  color: var(--sl-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.4;
}

.number-control {
  display: grid;
  width: 180px;
  flex: 0 0 180px;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--sl-space-sm);
}

.number-control :deep(.cmz-input-container) {
  min-height: 36px;
}

.number-control :deep(.cmz-input) {
  font-family: var(--sl-font-mono);
  font-size: 0.875rem;
}

.unit {
  color: var(--sl-text-tertiary);
  font-family: var(--sl-font-mono);
  font-size: 0.8125rem;
}

.jvm-entry {
  padding: var(--sl-space-sm) 0;
}

.jvm-textarea {
  width: 100%;
  min-height: 104px;
  margin-top: var(--sl-space-sm);
  padding: var(--sl-space-sm) var(--sl-space-md);
  resize: vertical;
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius-md);
  outline: none;
  background: var(--sl-surface);
  color: var(--sl-text-primary);
  font-family: var(--sl-font-mono);
  font-size: 0.875rem;
  line-height: 1.55;
  transition:
    border-color var(--sl-transition-fast),
    box-shadow var(--sl-transition-fast);
}

.jvm-textarea:hover:not(:disabled) {
  border-color: var(--sl-primary-light);
}

.jvm-textarea:focus {
  border-color: var(--sl-primary);
  box-shadow: var(--sl-shadow-input-focus);
}

.jvm-textarea:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.settings-actions {
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  gap: var(--sl-space-md);
  margin-top: var(--sl-space-md);
}

.settings-status {
  margin: 0;
}

@media (max-width: 760px) {
  .settings-entry {
    align-items: stretch;
    flex-direction: column;
    gap: var(--sl-space-md);
  }

  .number-control {
    width: 100%;
    flex-basis: auto;
  }
}
</style>
