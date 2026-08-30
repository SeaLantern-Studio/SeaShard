<script setup lang="ts">
import {
  serverJvmArgumentsMaximumLength,
  serverPortLimits,
  type ServerInstanceClientService,
  type ServerInstanceSnapshot,
  type ServerInstanceStartupSettings,
  type ServerRuntimeClientService,
  type ServerSettingsClientService,
  type ServerSettingsSnapshot,
} from "@seashard/contracts";
import type { ServerInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { Cmz_Button, Cmz_Card, Cmz_Input, Cmz_Spinner, Cmz_Switch } from "cmzya-modern-ui";
import { Server } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{
  instances: ServerInstanceClientService;
  runtime: ServerRuntimeClientService;
  settings: ServerSettingsClientService;
  selection: ServerInstanceSelection;
}>();

const registeredInstances = ref<readonly ServerInstanceSnapshot[]>([]);
const globalSettings = ref<ServerSettingsSnapshot>();
const baseline = ref<ServerInstanceStartupSettings>();
const minimumMemoryMiB = ref("");
const maximumMemoryMiB = ref("");
const serverPort = ref("");
const autoAcceptEula = ref(true);
const jvmArguments = ref("");
const loading = ref(true);
const saving = ref(false);
const previewCommand = ref("");
const previewError = ref("");
const previewLoading = ref(false);
const feedback = ref<{ tone: "error" | "success"; message: string }>();
let disposed = false;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewRequestId = 0;

const selectedInstance = computed(() =>
  registeredInstances.value.find((instance) => instance.id === props.selection.instanceId),
);
const dirty = computed(() => {
  const current = baseline.value;
  return (
    current !== undefined &&
    (minimumMemoryMiB.value !== String(current.minimumMemoryMiB) ||
      maximumMemoryMiB.value !== String(current.maximumMemoryMiB) ||
      serverPort.value !== String(current.serverPort) ||
      autoAcceptEula.value !== current.autoAcceptEula ||
      jvmArguments.value !== current.jvmArguments)
  );
});

onMounted(() => void load());
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(previewTimer);
});
watch(
  () => props.selection.instanceId,
  () => {
    if (!loading.value) applySelectedInstance();
  },
);
watch(
  [selectedInstance, minimumMemoryMiB, maximumMemoryMiB, serverPort, autoAcceptEula, jvmArguments],
  schedulePreview,
);

async function load(): Promise<void> {
  loading.value = true;
  feedback.value = undefined;
  try {
    const [instances, settings] = await Promise.all([props.instances.list(), props.settings.get()]);
    if (disposed) return;
    registeredInstances.value = instances;
    globalSettings.value = settings;
    if (
      !props.selection.instanceId ||
      !instances.some((instance) => instance.id === props.selection.instanceId)
    ) {
      props.selection.instanceId = instances[0]?.id;
    }
    applySelectedInstance();
  } catch (error) {
    if (!disposed) feedback.value = { tone: "error", message: errorMessage(error) };
  } finally {
    if (!disposed) loading.value = false;
  }
}

/** 尚未首次启动固化的实例以当前通用默认值预览；保存或首次启动后形成完整实例设置。 */
function applySelectedInstance(): void {
  const instance = selectedInstance.value;
  const defaults = globalSettings.value;
  if (!instance || !defaults) {
    baseline.value = undefined;
    return;
  }
  const values = instance.startupSettings ?? fromGlobalSettings(defaults);
  applyValues(values);
  feedback.value = undefined;
}

function fromGlobalSettings(settings: ServerSettingsSnapshot): ServerInstanceStartupSettings {
  return {
    minimumMemoryMiB: settings.defaultMinimumMemoryMiB,
    maximumMemoryMiB: settings.defaultMaximumMemoryMiB,
    serverPort: settings.defaultServerPort,
    autoAcceptEula: settings.autoAcceptEula,
    jvmArguments: settings.defaultJvmArguments,
  };
}

function applyValues(values: ServerInstanceStartupSettings): void {
  minimumMemoryMiB.value = String(values.minimumMemoryMiB);
  maximumMemoryMiB.value = String(values.maximumMemoryMiB);
  serverPort.value = String(values.serverPort);
  autoAcceptEula.value = values.autoAcceptEula;
  jvmArguments.value = values.jvmArguments;
  baseline.value = { ...values };
}

function updateText(target: "minimum" | "maximum" | "port" | "jvm", value: string | number): void {
  const text = String(value);
  if (target === "minimum") minimumMemoryMiB.value = text;
  if (target === "maximum") maximumMemoryMiB.value = text;
  if (target === "port") serverPort.value = text;
  if (target === "jvm") jvmArguments.value = text;
  feedback.value = undefined;
}

function updateJvmArguments(event: Event): void {
  if (event.target instanceof HTMLTextAreaElement) updateText("jvm", event.target.value);
}

function updateAutoAcceptEula(value: boolean): void {
  autoAcceptEula.value = value;
  feedback.value = undefined;
}

function createUpdate(): ServerInstanceStartupSettings {
  const minimum = parsePositiveInteger(minimumMemoryMiB.value, "最小内存");
  const maximum = parsePositiveInteger(maximumMemoryMiB.value, "最大内存");
  if (minimum > maximum) throw new Error("最小内存不能大于最大内存");
  const port = parsePositiveInteger(serverPort.value, "服务器端口");
  if (port < serverPortLimits.minimum || port > serverPortLimits.maximum) {
    throw new Error(
      `服务器端口必须在 ${serverPortLimits.minimum} 到 ${serverPortLimits.maximum} 之间`,
    );
  }
  if (jvmArguments.value.length > serverJvmArgumentsMaximumLength) {
    throw new Error(`JVM 参数不能超过 ${serverJvmArgumentsMaximumLength} 个字符`);
  }
  return {
    minimumMemoryMiB: minimum,
    maximumMemoryMiB: maximum,
    serverPort: port,
    autoAcceptEula: autoAcceptEula.value,
    jvmArguments: jvmArguments.value,
  };
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label}必须是正整数`);
  return parsed;
}

/** 输入有效时按当前草稿向 Host 请求真实核心策略和 Java 选择产生的命令。 */
function schedulePreview(): void {
  clearTimeout(previewTimer);
  const requestId = ++previewRequestId;
  const instance = selectedInstance.value;
  previewCommand.value = "";
  previewError.value = "";
  previewLoading.value = false;
  if (!instance) return;

  let startupSettings: ServerInstanceStartupSettings;
  try {
    startupSettings = createUpdate();
  } catch {
    previewError.value = "输入有效的启动参数后显示命令";
    return;
  }
  previewTimer = setTimeout(() => void loadPreview(instance.id, startupSettings, requestId), 150);
}

async function loadPreview(
  instanceId: string,
  startupSettings: ServerInstanceStartupSettings,
  requestId: number,
): Promise<void> {
  previewLoading.value = true;
  try {
    const preview = await props.runtime.preview(instanceId, startupSettings);
    if (disposed || requestId !== previewRequestId) return;
    previewCommand.value = preview.command;
  } catch (error) {
    if (disposed || requestId !== previewRequestId) return;
    previewError.value = errorMessage(error);
  } finally {
    if (!disposed && requestId === previewRequestId) previewLoading.value = false;
  }
}

async function save(): Promise<void> {
  const instance = selectedInstance.value;
  if (!instance || saving.value || !dirty.value) return;
  feedback.value = undefined;
  let update: ServerInstanceStartupSettings;
  try {
    update = createUpdate();
  } catch (error) {
    feedback.value = { tone: "error", message: errorMessage(error) };
    return;
  }

  saving.value = true;
  try {
    const saved = await props.instances.setStartupSettings(instance.id, update);
    if (disposed) return;
    registeredInstances.value = registeredInstances.value.map((candidate) =>
      candidate.id === saved.id ? saved : candidate,
    );
    applyValues(saved.startupSettings ?? update);
    feedback.value = { tone: "success", message: "实例启动设置已保存，将在下次启动时生效" };
  } catch (error) {
    if (!disposed) feedback.value = { tone: "error", message: errorMessage(error) };
  } finally {
    if (!disposed) saving.value = false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section class="instance-settings-page" aria-label="服务器实例设置">
    <div
      v-if="feedback"
      class="settings-feedback"
      :class="`settings-feedback--${feedback.tone}`"
      :role="feedback.tone === 'error' ? 'alert' : 'status'"
      aria-live="polite"
    >
      <span>{{ feedback.message }}</span>
      <Cmz_Button
        v-if="feedback.tone === 'error' && !selectedInstance"
        size="sm"
        variant="ghost"
        @click="load"
      >
        重新加载
      </Cmz_Button>
    </div>

    <div v-if="loading" class="settings-state" role="status">
      <Cmz_Spinner size="lg" />
      <span>正在读取实例启动设置…</span>
    </div>

    <div v-else-if="!selectedInstance" class="settings-state" role="status">
      <Server :size="32" :stroke-width="1.55" />
      <strong>还没有服务器实例</strong>
      <span>先下载服务器核心并创建实例，再配置专属启动参数。</span>
    </div>

    <Cmz_Card v-else title="启动设置">
      <div class="settings-entry">
        <div class="settings-entry-info">
          <label class="settings-entry-title" for="instance-maximum-memory">最大内存</label>
          <span class="settings-entry-desc">Java 进程可使用的最大堆内存，单位 MiB</span>
        </div>
        <div class="number-control">
          <Cmz_Input
            id="instance-maximum-memory"
            type="number"
            :min="1"
            :step="1"
            :model-value="maximumMemoryMiB"
            :disabled="saving"
            hide-number-controls
            aria-label="实例最大内存"
            @update:model-value="updateText('maximum', $event)"
          />
          <span class="unit">MiB</span>
        </div>
      </div>

      <div class="settings-entry">
        <div class="settings-entry-info">
          <label class="settings-entry-title" for="instance-minimum-memory">最小内存</label>
          <span class="settings-entry-desc">Java 进程启动时申请的初始堆内存，单位 MiB</span>
        </div>
        <div class="number-control">
          <Cmz_Input
            id="instance-minimum-memory"
            type="number"
            :min="1"
            :step="1"
            :model-value="minimumMemoryMiB"
            :disabled="saving"
            hide-number-controls
            aria-label="实例最小内存"
            @update:model-value="updateText('minimum', $event)"
          />
          <span class="unit">MiB</span>
        </div>
      </div>

      <div class="settings-entry">
        <div class="settings-entry-info">
          <label class="settings-entry-title" for="instance-server-port">服务器端口</label>
          <span class="settings-entry-desc">服务器启动后监听的网络端口</span>
        </div>
        <div class="number-control number-control--without-unit">
          <Cmz_Input
            id="instance-server-port"
            type="number"
            :min="serverPortLimits.minimum"
            :max="serverPortLimits.maximum"
            :step="1"
            :model-value="serverPort"
            :disabled="saving"
            hide-number-controls
            aria-label="实例服务器端口"
            @update:model-value="updateText('port', $event)"
          />
        </div>
      </div>

      <div class="settings-entry">
        <div class="settings-entry-info">
          <span class="settings-entry-title">自动同意 EULA</span>
          <span class="settings-entry-desc">
            启动前自动写入 eula=true；开启即表示你同意 Mojang 的最终用户许可协议
          </span>
        </div>
        <Cmz_Switch
          :model-value="autoAcceptEula"
          :disabled="saving"
          aria-label="实例自动同意 EULA"
          @update:model-value="updateAutoAcceptEula"
        />
      </div>

      <div class="jvm-entry">
        <label class="settings-entry-title" for="instance-jvm-arguments">JVM 参数</label>
        <span class="settings-entry-desc">追加到 Java 启动命令；内存参数由上方设置统一管理</span>
        <textarea
          id="instance-jvm-arguments"
          class="jvm-textarea"
          :value="jvmArguments"
          :maxlength="serverJvmArgumentsMaximumLength"
          :disabled="saving"
          :spellcheck="false"
          rows="4"
          placeholder="例如：-XX:+UseG1GC -XX:+ParallelRefProcEnabled"
          @input="updateJvmArguments"
        />
      </div>

      <div class="command-preview">
        <span class="settings-entry-title">启动命令预览</span>
        <div class="command-preview-surface" role="status" aria-live="polite">
          <Cmz_Spinner v-if="previewLoading" size="sm" />
          <pre v-else-if="previewCommand"><code>{{ previewCommand }}</code></pre>
          <span v-else>{{ previewError || "正在生成启动命令…" }}</span>
        </div>
      </div>

      <div class="settings-actions">
        <Cmz_Button size="sm" :loading="saving" :disabled="!baseline || !dirty" @click="save">
          保存设置
        </Cmz_Button>
      </div>
    </Cmz_Card>
  </section>
</template>

<style scoped>
.instance-settings-page {
  display: flex;
  width: 100%;
  max-width: 900px;
  flex-direction: column;
  gap: var(--sl-space-lg);
  margin: 0 auto;
  padding-bottom: var(--sl-space-2xl);
}

.settings-feedback {
  display: flex;
  min-height: 42px;
  align-items: center;
  justify-content: space-between;
  gap: var(--sl-space-md);
  padding: var(--sl-space-sm) var(--sl-space-md);
  border: 1px solid;
  border-radius: var(--sl-radius-md);
  font-size: 0.875rem;
  line-height: 1.45;
}

.settings-feedback--error {
  border-color: color-mix(in srgb, var(--sl-error) 30%, transparent);
  background: color-mix(in srgb, var(--sl-error) 8%, var(--sl-surface));
  color: var(--sl-error);
}

.settings-feedback--success {
  border-color: color-mix(in srgb, var(--sl-success) 30%, transparent);
  background: color-mix(in srgb, var(--sl-success) 8%, var(--sl-surface));
  color: var(--sl-success);
}

.settings-state {
  display: flex;
  min-height: 260px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sl-space-sm);
  color: var(--sl-text-tertiary);
  text-align: center;
}

.settings-state strong {
  color: var(--sl-text-primary);
  font-size: 1rem;
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

.number-control--without-unit {
  grid-template-columns: minmax(0, 1fr);
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

.command-preview {
  padding: var(--sl-space-md) 0;
  border-top: 1px solid var(--sl-border-light);
}

.command-preview-surface {
  display: flex;
  min-height: 64px;
  align-items: center;
  margin-top: var(--sl-space-sm);
  padding: var(--sl-space-md);
  overflow-x: auto;
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius-md);
  background: var(--sl-bg-secondary);
  color: var(--sl-text-secondary);
  font-size: 0.9375rem;
}

.command-preview-surface pre {
  min-width: 100%;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.command-preview-surface code {
  color: var(--sl-text-primary);
  font-family: var(--sl-font-mono);
  line-height: 1.35;
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--sl-space-md);
  border-top: 1px solid var(--sl-border-light);
}

@media (max-width: 720px) {
  .settings-entry {
    align-items: stretch;
    flex-direction: column;
    gap: var(--sl-space-sm);
  }

  .number-control {
    width: 100%;
    flex-basis: auto;
  }
}
</style>
