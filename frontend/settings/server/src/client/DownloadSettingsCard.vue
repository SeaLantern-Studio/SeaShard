<script setup lang="ts">
import type { ServerSettingsClientService } from "@seashard/contracts";
import { Cmz_Button, Cmz_Card, Cmz_Input } from "cmzya-modern-ui";
import { FolderOpen } from "lucide-vue-next";
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{
  selectDirectory: () => Promise<string | undefined>;
  settings: ServerSettingsClientService;
}>();

const resourceDirectory = ref("");
const loading = ref(true);
const selecting = ref(false);
const settingsError = ref<string>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingDirectory: string | undefined;
let saveQueue: Promise<void> = Promise.resolve();
let saveRevision = 0;
let disposed = false;

onMounted(async () => {
  try {
    const snapshot = await props.settings.get();
    if (!disposed) resourceDirectory.value = snapshot.resourceDownloadDirectory;
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

function persistDirectory(directory: string): Promise<void> {
  const revision = ++saveRevision;
  const task = saveQueue.then(() => props.settings.setResourceDownloadDirectory(directory));
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
  <Cmz_Card title="下载设置" subtitle="配置服务器资源的默认保存位置">
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
}
</style>
