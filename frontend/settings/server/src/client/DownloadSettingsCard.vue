<script setup lang="ts">
import {
  serverDownloadConnectionLimits,
  type ServerSettingsClientService,
} from "@seashard/contracts";
import { Cmz_Button, Cmz_Card, Cmz_Input, Cmz_Select } from "cmzya-modern-ui";
import { FolderOpen } from "lucide-vue-next";
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{
  selectDirectory: () => Promise<string | undefined>;
  settings: ServerSettingsClientService;
}>();

const resourceDirectory = ref("");
const defaultConnections = ref<number>(serverDownloadConnectionLimits.defaultValue);
const loading = ref(true);
const selecting = ref(false);
const settingsError = ref<string>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingDirectory: string | undefined;
let saveQueue: Promise<void> = Promise.resolve();
let saveRevision = 0;
let disposed = false;
const connectionOptions = [1, 2, 4, 8, 16, 32].map((value) => ({
  label:
    value === serverDownloadConnectionLimits.defaultValue
      ? `${value} 线程（推荐）`
      : `${value} 线程`,
  value,
}));

onMounted(async () => {
  try {
    const snapshot = await props.settings.get();
    if (!disposed) {
      resourceDirectory.value = snapshot.resourceDownloadDirectory;
      defaultConnections.value = snapshot.defaultDownloadConnections;
    }
  } catch (error) {
    if (!disposed) settingsError.value = errorMessage(error);
  } finally {
    if (!disposed) loading.value = false;
  }
});

onBeforeUnmount(() => {
  disposed = true;
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  if (pendingDirectory !== undefined) void persistDirectory(pendingDirectory);
});

function updateResourceDirectory(value: string): void {
  resourceDirectory.value = value;
  settingsError.value = undefined;
  pendingDirectory = value;
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    pendingDirectory = undefined;
    void persistDirectory(value);
  }, 450);
}

async function browseDirectory(): Promise<void> {
  if (loading.value || selecting.value) return;
  selecting.value = true;
  settingsError.value = undefined;
  try {
    const selectedDirectory = await props.selectDirectory();
    if (!selectedDirectory) return;
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = undefined;
    pendingDirectory = undefined;
    resourceDirectory.value = selectedDirectory;
    await persistDirectory(selectedDirectory);
  } catch (error) {
    if (!disposed) settingsError.value = errorMessage(error);
  } finally {
    if (!disposed) selecting.value = false;
  }
}

function updateDefaultConnections(value: string | number): void {
  if (typeof value !== "number" || !connectionOptions.some((option) => option.value === value)) {
    return;
  }
  defaultConnections.value = value;
  settingsError.value = undefined;
  void persistUpdate(() => props.settings.setDefaultDownloadConnections(value));
}

function persistDirectory(directory: string): Promise<void> {
  return persistUpdate(() => props.settings.setResourceDownloadDirectory(directory));
}

function persistUpdate(
  update: () => ReturnType<ServerSettingsClientService["get"]>,
): Promise<void> {
  const revision = ++saveRevision;
  const task = saveQueue.then(update);
  saveQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task.then(
    () => {
      if (!disposed && revision === saveRevision) settingsError.value = undefined;
    },
    (error: unknown) => {
      if (!disposed && revision === saveRevision) settingsError.value = errorMessage(error);
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <Cmz_Card title="下载设置" subtitle="配置服务器资源的默认保存位置和并发线程数">
    <div class="settings-entry">
      <div class="settings-entry-info">
        <span class="settings-entry-title">资源默认下载地址</span>
        <span class="settings-entry-desc">核心等受管理资源将默认下载到此目录</span>
      </div>

      <div class="directory-control">
        <Cmz_Input
          id="resource-download-directory"
          class="directory-input"
          aria-label="资源默认下载地址"
          :model-value="resourceDirectory"
          placeholder="输入或选择目录"
          :spellcheck="false"
          :disabled="loading"
          @update:model-value="updateResourceDirectory"
        />
        <Cmz_Button
          class="browse-button"
          variant="outline"
          size="sm"
          :loading="selecting"
          :disabled="loading"
          @click="browseDirectory"
        >
          <FolderOpen :size="16" :stroke-width="1.8" />
          浏览
        </Cmz_Button>
      </div>
    </div>

    <div class="settings-entry">
      <div class="settings-entry-info">
        <span class="settings-entry-title">默认下载线程数</span>
        <span class="settings-entry-desc">
          服务器核心下载默认使用此并发数；不支持分段的来源会自动回退为单线程
        </span>
      </div>

      <div class="connection-control">
        <Cmz_Select
          :model-value="defaultConnections"
          :options="connectionOptions"
          :disabled="loading"
          aria-label="默认下载线程数"
          @update:model-value="updateDefaultConnections"
        />
      </div>
    </div>

    <p v-if="settingsError" class="settings-error" role="alert">
      {{ settingsError }}
    </p>
  </Cmz_Card>
</template>

<style scoped>
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

.directory-control {
  display: grid;
  min-width: 0;
  flex: 0 1 480px;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--sl-space-sm);
}

.directory-input {
  width: 100%;
  min-width: 0;
}

.directory-input :deep(.cmz-input-container) {
  min-height: 36px;
}

.directory-input :deep(.cmz-input) {
  font-family: var(--sl-font-mono);
  font-size: 0.875rem;
}

.browse-button {
  white-space: nowrap;
}

.connection-control {
  width: 180px;
  flex: 0 0 180px;
}

.browse-button:active {
  transform: scale(0.97);
}

.settings-error {
  margin: var(--sl-space-sm) 0 0;
  color: var(--sl-error);
  font-size: 0.8125rem;
}

@media (max-width: 760px) {
  .settings-entry {
    align-items: stretch;
    flex-direction: column;
    gap: var(--sl-space-md);
  }

  .directory-control {
    width: 100%;
    flex-basis: auto;
  }

  .connection-control {
    width: 100%;
    flex-basis: auto;
  }
}
</style>
