<script setup lang="ts">
import type {
  ServerFileEntry,
  ServerFileManagerService,
  ServerInstanceClientService,
  ServerInstanceSnapshot,
  ServerTextFileDocument,
} from "@seashard/contracts";
import type { ServerInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { Cmz_Button, Cmz_Modal, Cmz_Spinner, useToast } from "cmzya-modern-ui";
import {
  ChevronLeft,
  File,
  Folder,
  FolderPlus,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-vue-next";
import { computed, onMounted, ref, watch } from "vue";

const props = defineProps<{
  instances: ServerInstanceClientService;
  files: ServerFileManagerService;
  selection: ServerInstanceSelection;
}>();
const toast = useToast();
const registeredInstances = ref<readonly ServerInstanceSnapshot[]>([]);
const directory = ref("");
const entries = ref<readonly ServerFileEntry[]>([]);
const document = ref<ServerTextFileDocument>();
const draft = ref("");
const loading = ref(false);
const saving = ref(false);
const createName = ref("");
const deleteTarget = ref<ServerFileEntry>();
const selectedInstanceId = computed(() => props.selection.instanceId);
const breadcrumbs = computed(() => {
  const parts = directory.value ? directory.value.split("/") : [];
  return [
    { label: "根目录", path: "" },
    ...parts.map((label, index) => ({ label, path: parts.slice(0, index + 1).join("/") })),
  ];
});

onMounted(() => void loadInstances());
watch(selectedInstanceId, () => {
  directory.value = "";
  document.value = undefined;
  void loadDirectory();
});

async function loadInstances(): Promise<void> {
  loading.value = true;
  try {
    registeredInstances.value = await props.instances.list();
    if (!registeredInstances.value.some(({ id }) => id === props.selection.instanceId)) {
      props.selection.instanceId = registeredInstances.value[0]?.id;
    }
    await loadDirectory();
  } catch (error) {
    toast.error({ title: "读取文件失败", description: errorMessage(error) });
  } finally {
    loading.value = false;
  }
}

async function loadDirectory(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId) {
    entries.value = [];
    return;
  }
  loading.value = true;
  try {
    entries.value = await props.files.list(instanceId, directory.value);
  } catch (error) {
    toast.error({ title: "读取目录失败", description: errorMessage(error) });
  } finally {
    loading.value = false;
  }
}

function openDirectory(path: string): void {
  directory.value = path;
  document.value = undefined;
  void loadDirectory();
}

async function openFile(entry: ServerFileEntry): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId) return;
  loading.value = true;
  try {
    const loaded = await props.files.readText(instanceId, entry.path);
    document.value = loaded;
    draft.value = loaded.content;
  } catch (error) {
    toast.error({ title: "无法打开文件", description: errorMessage(error) });
  } finally {
    loading.value = false;
  }
}

async function saveDocument(): Promise<void> {
  const current = document.value;
  if (!current || saving.value) return;
  saving.value = true;
  try {
    document.value = await props.files.writeText({
      instanceId: current.instanceId,
      path: current.path,
      content: draft.value,
      expectedRevision: current.revision,
    });
    toast.success({ title: "文件已保存" });
    await loadDirectory();
  } catch (error) {
    toast.error({ title: "保存文件失败", description: errorMessage(error) });
  } finally {
    saving.value = false;
  }
}

async function createEntry(kind: "file" | "directory"): Promise<void> {
  const instanceId = selectedInstanceId.value;
  const name = createName.value.trim();
  if (!instanceId || !name) return;
  const path = directory.value ? `${directory.value}/${name}` : name;
  try {
    if (kind === "directory") await props.files.createDirectory(instanceId, path);
    else await props.files.writeText({ instanceId, path, content: "" });
    createName.value = "";
    toast.success({ title: kind === "directory" ? "目录已创建" : "文件已创建" });
    await loadDirectory();
  } catch (error) {
    toast.error({ title: "创建失败", description: errorMessage(error) });
  }
}

async function confirmDelete(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  const target = deleteTarget.value;
  if (!instanceId || !target) return;
  try {
    await props.files.delete(instanceId, target.path);
    if (document.value?.path === target.path) document.value = undefined;
    deleteTarget.value = undefined;
    toast.success({ title: target.kind === "directory" ? "目录已删除" : "文件已删除" });
    await loadDirectory();
  } catch (error) {
    toast.error({ title: "删除失败", description: errorMessage(error) });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section class="server-files-page">
    <header class="page-heading"><h1>文件</h1></header>
    <div class="files-toolbar">
      <select v-model="selection.instanceId" aria-label="服务器实例">
        <option v-for="instance in registeredInstances" :key="instance.id" :value="instance.id">
          {{ instance.name }}
        </option>
      </select>
      <div class="breadcrumbs" aria-label="当前目录">
        <button
          v-for="item in breadcrumbs"
          :key="item.path"
          type="button"
          @click="openDirectory(item.path)"
        >
          {{ item.label }}
        </button>
      </div>
      <Cmz_Button variant="outline" size="sm" :disabled="loading" @click="loadDirectory">
        <RefreshCw :size="15" /> 刷新
      </Cmz_Button>
    </div>

    <div class="create-row">
      <input
        v-model="createName"
        maxlength="128"
        placeholder="新文件或目录名称"
        @keydown.enter="createEntry('file')"
      />
      <Cmz_Button
        variant="outline"
        size="sm"
        :disabled="!createName.trim()"
        @click="createEntry('file')"
      >
        <Plus :size="15" /> 文件
      </Cmz_Button>
      <Cmz_Button
        variant="outline"
        size="sm"
        :disabled="!createName.trim()"
        @click="createEntry('directory')"
      >
        <FolderPlus :size="15" /> 目录
      </Cmz_Button>
    </div>

    <div class="files-workspace">
      <div class="entry-pane">
        <button
          v-if="directory"
          type="button"
          class="entry-row"
          @click="openDirectory(directory.split('/').slice(0, -1).join('/'))"
        >
          <ChevronLeft :size="17" /> <span>返回上级</span>
        </button>
        <Cmz_Spinner v-if="loading" />
        <div v-else class="entry-list">
          <div v-for="entry in entries" :key="entry.path" class="entry-row">
            <button
              type="button"
              class="entry-open"
              @click="entry.kind === 'directory' ? openDirectory(entry.path) : openFile(entry)"
            >
              <Folder v-if="entry.kind === 'directory'" :size="17" />
              <File v-else :size="17" />
              <span>{{ entry.name }}</span>
            </button>
            <button
              type="button"
              class="icon-button danger"
              aria-label="删除"
              @click="deleteTarget = entry"
            >
              <Trash2 :size="15" />
            </button>
          </div>
        </div>
      </div>

      <div class="editor-pane">
        <template v-if="document">
          <div class="editor-heading">
            <strong>{{ document.path }}</strong>
            <Cmz_Button
              size="sm"
              :loading="saving"
              :disabled="draft === document.content"
              @click="saveDocument"
            >
              <Save :size="15" /> 保存
            </Cmz_Button>
          </div>
          <textarea v-model="draft" spellcheck="false" aria-label="文件内容"></textarea>
        </template>
        <div v-else class="empty-editor"><File :size="28" /><span>选择 UTF-8 文本文件</span></div>
      </div>
    </div>

    <Cmz_Modal
      :visible="Boolean(deleteTarget)"
      title="删除文件"
      width="440px"
      @close="deleteTarget = undefined"
    >
      <p>确认删除“{{ deleteTarget?.name }}”？非空目录会被 Host 拒绝。</p>
      <template #footer>
        <div class="modal-actions">
          <Cmz_Button variant="outline" @click="deleteTarget = undefined">取消</Cmz_Button>
          <Cmz_Button color="#ef4444" @click="confirmDelete">删除</Cmz_Button>
        </div>
      </template>
    </Cmz_Modal>
  </section>
</template>

<style scoped src="./ServerFilesPage.css"></style>
