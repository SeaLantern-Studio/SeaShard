<script setup lang="ts">
import { Cmz_Button, Cmz_Card, Cmz_Input } from "cmzya-modern-ui";
import { FolderOpen } from "lucide-vue-next";
import { ref } from "vue";

const props = defineProps<{
  selectDirectory: () => Promise<string | undefined>;
}>();

const resourceDirectory = ref("");
const selecting = ref(false);
const selectionError = ref<string>();
function updateResourceDirectory(value: string): void {
  resourceDirectory.value = value;
  selectionError.value = undefined;
}

async function browseDirectory(): Promise<void> {
  if (selecting.value) return;
  selecting.value = true;
  selectionError.value = undefined;
  try {
    const selectedDirectory = await props.selectDirectory();
    if (selectedDirectory) resourceDirectory.value = selectedDirectory;
  } catch (error) {
    selectionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    selecting.value = false;
  }
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
          @update:model-value="updateResourceDirectory"
        />
        <Cmz_Button
          class="browse-button"
          variant="outline"
          size="sm"
          :loading="selecting"
          @click="browseDirectory"
        >
          <FolderOpen :size="16" :stroke-width="1.8" />
          浏览
        </Cmz_Button>
      </div>
    </div>

    <p v-if="selectionError" class="selection-error" role="alert">
      {{ selectionError }}
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

.selection-error {
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
