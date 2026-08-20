<script setup lang="ts">
import type {
  ServerConfigurationCatalog,
  ServerConfigurationClientService,
  ServerConfigurationDocument,
  ServerConfigurationFile,
  ServerInstanceClientService,
  ServerInstanceSnapshot,
} from "@seashard/contracts";
import {
  Cmz_Badge,
  Cmz_Button,
  Cmz_Input,
  Cmz_Modal,
  Cmz_Select,
  Cmz_Spinner,
  Cmz_Switch,
  Cmz_TabBar,
  Cmz_Tooltip,
  type SelectOption,
  type TabBarItem,
} from "cmzya-modern-ui";
import {
  AlertTriangle,
  Edit,
  FileCode2,
  FileText,
  FolderCog,
  RefreshCw,
  Save,
  Settings,
} from "lucide-vue-next";
import { computed, defineComponent, h, onMounted, reactive, ref, watch } from "vue";
import ConfigSourceDiffView from "./ConfigSourceDiffView.vue";
import ConfigSourceEditor from "./ConfigSourceEditor.vue";
import { buildChangedConfigurationLines } from "./config-diff";
import {
  parseServerPropertiesSource,
  renderServerPropertiesSource,
  serverPropertyCategories,
  type ServerPropertyEntry,
} from "./server-properties";
import type { ServerInstanceSelection } from "./server-selection";
type ConfigurationScope = ServerConfigurationFile["scope"];

interface ConfigurationDraft {
  document: ServerConfigurationDocument;
  content: string;
}

const props = defineProps<{
  instances: ServerInstanceClientService;
  configuration: ServerConfigurationClientService;
  selection: ServerInstanceSelection;
}>();

const registeredInstances = ref<readonly ServerInstanceSnapshot[]>([]);
const catalog = ref<ServerConfigurationCatalog>();
const activeScope = ref<ConfigurationScope>("server");
const selectedPath = ref("");
const selectedPluginName = ref("");
const editorMode = ref<"visual" | "source">("visual");
const searchQuery = ref("");
const activeCategory = ref("all");
const loading = ref(true);
const catalogLoading = ref(false);
const documentLoading = ref(false);
const saving = ref(false);
const error = ref("");
const previewOpen = ref(false);
const reloadConfirmOpen = ref(false);
const drafts = reactive(new Map<string, ConfigurationDraft>());
let catalogRequestId = 0;
let documentRequestId = 0;

const selectedInstanceId = computed(() => props.selection.instanceId ?? "");
const selectedInstance = computed(() =>
  registeredInstances.value.find((instance) => instance.id === selectedInstanceId.value),
);
const selectedFile = computed(() =>
  allFiles.value.find((file) => file.path === selectedPath.value),
);
const allFiles = computed(() => [
  ...(catalog.value?.serverFiles ?? []),
  ...(catalog.value?.otherFiles ?? []),
  ...(catalog.value?.plugins.flatMap((plugin) => plugin.files) ?? []),
]);
const activeConfigurationFiles = computed(() =>
  activeScope.value === "other"
    ? (catalog.value?.otherFiles ?? [])
    : (catalog.value?.serverFiles ?? []),
);
const selectedDraft = computed(() =>
  drafts.get(draftKey(selectedInstanceId.value, selectedPath.value)),
);
/** 在不依赖 Node path 模块的 Renderer 中，按实例路径风格拼出完整配置文件位置。 */
const selectedConfigurationLocation = computed(() => {
  const activeConfigurationPath =
    selectedFile.value?.scope !== "plugin"
      ? (selectedDraft.value?.document.path ?? selectedFile.value?.path)
      : undefined;
  const filePath =
    activeConfigurationPath ??
    catalog.value?.serverFiles[0]?.path ??
    catalog.value?.otherFiles[0]?.path;
  const rootPath = catalog.value?.configurationRootPath.replace(/[\\/]+$/u, "");
  if (!filePath) return "尚未选择配置文件";
  if (!rootPath) return filePath;
  const separator = rootPath.includes("\\") ? "\\" : "/";
  return `${rootPath}${separator}${filePath.replace(/[\\/]+/gu, separator)}`;
});

/**
 * Cmz_TabBar 只接受组件形式的后缀；通过局部组件把路径提示接回 CMZ Tooltip。
 */
const ConfigurationPathTooltip = defineComponent({
  name: "ConfigurationPathTooltip",
  inheritAttrs: false,
  setup() {
    return () =>
      h(
        Cmz_Tooltip,
        {
          content: selectedConfigurationLocation.value,
          placement: "bottom",
        },
        {
          default: () =>
            h(
              "span",
              {
                class: "configuration-path-info",
                "aria-label": `配置文件位置：${selectedConfigurationLocation.value}`,
              },
              "i",
            ),
        },
      );
  },
});
const hasUnsavedChanges = computed(
  () =>
    !!selectedDraft.value && selectedDraft.value.content !== selectedDraft.value.document.content,
);
const supportsVisualEditor = computed(
  () => selectedFile.value?.scope === "server" && selectedFile.value.path === "server.properties",
);
const propertyEntries = computed(() =>
  selectedDraft.value ? parseServerPropertiesSource(selectedDraft.value.content) : [],
);
const filteredPropertyEntries = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  return propertyEntries.value.filter(
    (entry) =>
      (activeCategory.value === "all" || entry.category === activeCategory.value) &&
      (!query ||
        entry.key.toLowerCase().includes(query) ||
        entry.description.toLowerCase().includes(query)),
  );
});
const invalidNumericKeys = computed(() =>
  propertyEntries.value
    .filter((entry) => entry.valueType === "number" && !/^-?\d+$/u.test(entry.value.trim()))
    .map((entry) => entry.key),
);
const configurationDiffLines = computed(() => {
  const draft = selectedDraft.value;
  return draft ? buildChangedConfigurationLines(draft.document.content, draft.content) : [];
});
const addedLineCount = computed(
  () => configurationDiffLines.value.filter((line) => line.type === "addition").length,
);
const deletedLineCount = computed(
  () => configurationDiffLines.value.filter((line) => line.type === "deletion").length,
);
const scopeTabs = computed<TabBarItem[]>(() => {
  const tabs: TabBarItem[] = [
    {
      key: "server",
      label: "服务器配置",
      suffixIcon: ConfigurationPathTooltip,
    },
  ];
  if (catalog.value?.otherFiles.length) {
    tabs.push({
      key: "other",
      label: "其他配置",
    });
  }
  tabs.push({
    key: "plugin",
    label: "插件配置",
    disabled: !catalog.value?.pluginSupported,
  });
  return tabs;
});
const configurationFileTabs = computed<TabBarItem[]>(() =>
  activeConfigurationFiles.value.map((file) => ({
    key: file.path,
    label: file.name,
    count: fileKindLabel(file),
    countTitle: file.path,
  })),
);
const categoryTabs: TabBarItem[] = serverPropertyCategories.map((category) => ({
  key: category.id,
  label: category.label,
}));
const editorModeTabs: TabBarItem[] = [
  { key: "visual", label: "可视化" },
  { key: "source", label: "源文件" },
];
const gamemodeOptions: SelectOption[] = [
  { label: "生存", value: "survival" },
  { label: "创造", value: "creative" },
  { label: "冒险", value: "adventure" },
  { label: "旁观", value: "spectator" },
];
const difficultyOptions: SelectOption[] = [
  { label: "和平", value: "peaceful" },
  { label: "简单", value: "easy" },
  { label: "普通", value: "normal" },
  { label: "困难", value: "hard" },
];
const saveStatusText = computed(() => (hasUnsavedChanges.value ? "有未保存修改" : "已保存"));

onMounted(() => void loadInstances());

watch(
  () => props.selection.instanceId,
  (instanceId, previousInstanceId) => {
    if (instanceId === previousInstanceId) return;
    catalogRequestId += 1;
    documentRequestId += 1;
    catalog.value = undefined;
    selectedPath.value = "";
    selectedPluginName.value = "";
    editorMode.value = "visual";
    void loadInstances();
  },
);

/** 实例 ID 只用于调用受限 Contract；根目录路径不会由页面回传给 Host。 */
async function loadInstances(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const instances = await props.instances.list();
    registeredInstances.value = instances;
    if (!selectedInstance.value) {
      catalog.value = undefined;
      selectedPath.value = "";
      return;
    }
    await loadCatalog();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}
async function loadCatalog(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId) return;
  const requestId = ++catalogRequestId;
  catalogLoading.value = true;
  error.value = "";
  try {
    const result = await props.configuration.list(instanceId);
    if (requestId !== catalogRequestId || instanceId !== selectedInstanceId.value) return;
    catalog.value = result;
    chooseAvailableFile();
  } catch (cause) {
    if (requestId === catalogRequestId) {
      catalog.value = undefined;
      error.value = errorMessage(cause);
    }
  } finally {
    if (requestId === catalogRequestId) catalogLoading.value = false;
  }
}

function chooseAvailableFile(): void {
  const current = allFiles.value.find((file) => file.path === selectedPath.value);
  if (current) {
    activeScope.value = current.scope;
    void ensureDocument(current);
    return;
  }
  const firstServerFile = catalog.value?.serverFiles[0];
  const firstOtherFile = catalog.value?.otherFiles[0];
  const firstPlugin = catalog.value?.plugins[0];
  const firstFile = firstServerFile ?? firstOtherFile ?? firstPlugin?.files[0];
  selectedPluginName.value = firstFile?.scope === "plugin" ? (firstPlugin?.name ?? "") : "";
  if (firstFile) {
    void selectFile(firstFile);
  } else {
    activeScope.value = "server";
    selectedPath.value = "";
  }
}

function selectScope(scope: ConfigurationScope): void {
  if (scope === "other" && !catalog.value?.otherFiles.length) return;
  if (scope === "plugin" && !catalog.value?.pluginSupported) return;
  activeScope.value = scope;
  const current = selectedFile.value;
  if (current?.scope === scope) return;
  if (scope === "plugin") {
    selectedPath.value = "";
    return;
  }
  const firstFile =
    scope === "other" ? catalog.value?.otherFiles[0] : catalog.value?.serverFiles[0];
  if (firstFile) void selectFile(firstFile);
  else selectedPath.value = "";
}

function handleScopeTab(value: string | null): void {
  if (value === "server" || value === "other" || value === "plugin") selectScope(value);
}

function handleConfigurationFileTab(value: string | null): void {
  const file = activeConfigurationFiles.value.find((candidate) => candidate.path === value);
  if (file) void selectFile(file);
}

function handleEditorModeTab(value: string | null): void {
  if (value === "visual" || value === "source") editorMode.value = value;
}

function handleCategoryTab(value: string | null): void {
  if (value) activeCategory.value = value;
}

function selectPlugin(name: string): void {
  const closing = selectedPluginName.value === name;
  if (!closing && selectedFile.value?.pluginName !== name) selectedPath.value = "";
  selectedPluginName.value = closing ? "" : name;
  if (closing && selectedFile.value?.pluginName === name) selectedPath.value = "";
}

async function selectFile(file: ServerConfigurationFile): Promise<void> {
  activeScope.value = file.scope;
  selectedPath.value = file.path;
  if (file.pluginName) selectedPluginName.value = file.pluginName;
  editorMode.value = file.path === "server.properties" ? editorMode.value : "source";
  error.value = "";
  await ensureDocument(file);
}

async function ensureDocument(file: ServerConfigurationFile, force = false): Promise<void> {
  const instanceId = selectedInstanceId.value;
  const key = draftKey(instanceId, file.path);
  if (!force && drafts.has(key)) return;
  const requestId = ++documentRequestId;
  documentLoading.value = true;
  try {
    const document = await props.configuration.read(instanceId, file.path);
    if (
      requestId !== documentRequestId ||
      instanceId !== selectedInstanceId.value ||
      file.path !== selectedPath.value
    ) {
      return;
    }
    drafts.set(key, { document, content: document.content });
  } catch (cause) {
    if (requestId === documentRequestId) error.value = errorMessage(cause);
  } finally {
    if (requestId === documentRequestId) documentLoading.value = false;
  }
}

function updateSource(content: string): void {
  const draft = selectedDraft.value;
  if (draft) draft.content = content;
}

function updateProperty(entry: ServerPropertyEntry, value: string): void {
  const draft = selectedDraft.value;
  if (!draft) return;
  draft.content = renderServerPropertiesSource(draft.content, { [entry.key]: value });
}

function updateBoolean(entry: ServerPropertyEntry, value: boolean): void {
  updateProperty(entry, String(value));
}

function updateSelect(entry: ServerPropertyEntry, value: string | number): void {
  updateProperty(entry, String(value));
}

async function reloadSelectedDocument(): Promise<void> {
  const file = selectedFile.value;
  if (!file) return;
  if (hasUnsavedChanges.value) {
    reloadConfirmOpen.value = true;
    return;
  }
  await ensureDocument(file, true);
}

async function confirmReload(): Promise<void> {
  const file = selectedFile.value;
  reloadConfirmOpen.value = false;
  if (file) await ensureDocument(file, true);
}

function openSavePreview(): void {
  if (
    !hasUnsavedChanges.value ||
    invalidNumericKeys.value.length > 0 ||
    configurationDiffLines.value.length === 0
  ) {
    return;
  }
  previewOpen.value = true;
}

/** expectedRevision 让 Host 在外部修改发生时拒绝覆盖；成功响应会成为下一次保存的新基线。 */
async function confirmSave(): Promise<void> {
  const draft = selectedDraft.value;
  if (!draft || !hasUnsavedChanges.value || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const saved = await props.configuration.write({
      instanceId: draft.document.instanceId,
      path: draft.document.path,
      content: draft.content,
      expectedRevision: draft.document.revision,
    });
    drafts.set(draftKey(saved.instanceId, saved.path), { document: saved, content: saved.content });
    previewOpen.value = false;
  } catch (cause) {
    previewOpen.value = false;
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}

function draftKey(instanceId: string, path: string): string {
  return `${instanceId}\0${path}`;
}

function fileKindLabel(file: ServerConfigurationFile): string {
  if (file.kind === "properties") return "Properties";
  if (file.kind === "yaml") return "YAML";
  if (file.kind === "json") return "JSON";
  if (file.kind === "toml") return "TOML / Conf";
  return "Text";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
</script>

<template>
  <section class="server-configuration-page config-view" aria-label="服务器配置管理">
    <div v-if="loading" class="loading-state">
      <Cmz_Spinner size="lg" />
      <span>正在读取服务器实例…</span>
    </div>

    <div v-else-if="!selectedInstance" class="empty-state">
      <FolderCog :size="32" :stroke-width="1.55" />
      <strong>{{
        registeredInstances.length === 0 ? "还没有服务器实例" : "请先选择服务器"
      }}</strong>
      <span>
        {{
          registeredInstances.length === 0
            ? "先下载服务器核心并创建实例，配置文件生成后会显示在这里。"
            : "请返回服务器启动页面选择当前服务器，再打开配置管理。"
        }}
      </span>
    </div>

    <template v-else>
      <div class="config-tabs-row">
        <Cmz_TabBar
          class="config-scope-tabs"
          :model-value="activeScope"
          :tabs="scopeTabs"
          :level="1"
          @update:model-value="handleScopeTab"
        />
        <Cmz_TabBar
          v-if="activeScope === 'server' && supportsVisualEditor"
          class="config-editor-mode-bar"
          :model-value="editorMode"
          :tabs="editorModeTabs"
          :level="2"
          @update:model-value="handleEditorModeTab"
        />
      </div>

      <div v-if="error" class="error-banner" role="alert">
        <span>{{ error }}</span>
        <Cmz_Button variant="ghost" size="sm" icon-only aria-label="关闭错误" @click="error = ''">
          ×
        </Cmz_Button>
      </div>

      <template v-if="activeScope !== 'plugin'">
        <div v-if="catalogLoading" class="loading-state">
          <Cmz_Spinner size="lg" />
          <span>正在扫描配置文件…</span>
        </div>

        <div v-else-if="activeConfigurationFiles.length === 0" class="empty-state">
          <FileCode2 :size="30" :stroke-width="1.5" />
          <strong>
            {{ activeScope === "other" ? "尚未发现其他配置" : "尚未生成服务器配置" }}
          </strong>
          <span>
            {{ activeScope === "other" ? "当前实例没有额外配置文件。" : "请先启动一次服务器。" }}
          </span>
        </div>

        <template v-else>
          <Cmz_TabBar
            v-if="activeConfigurationFiles.length > 1"
            class="server-file-tabs"
            :model-value="selectedPath"
            :tabs="configurationFileTabs"
            :level="2"
            @update:model-value="handleConfigurationFileTab"
          />

          <div v-if="documentLoading" class="loading-state">
            <Cmz_Spinner size="lg" />
            <span>正在读取配置文件…</span>
          </div>

          <div v-else-if="!selectedDraft || !selectedFile" class="empty-state">
            <FileCode2 :size="30" :stroke-width="1.5" />
            <strong>选择一个配置文件</strong>
          </div>

          <template v-else>
            <template v-if="supportsVisualEditor && editorMode === 'visual'">
              <Cmz_TabBar
                class="config-category-bar"
                :model-value="activeCategory"
                :tabs="categoryTabs"
                :level="2"
                @update:model-value="handleCategoryTab"
              >
                <template #extra>
                  <Cmz_Input
                    v-model="searchQuery"
                    class="config-search-input"
                    placeholder="搜索属性或说明"
                  />
                </template>
              </Cmz_TabBar>

              <div class="config-entries">
                <article
                  v-for="entry in filteredPropertyEntries"
                  :key="entry.key"
                  class="config-entry"
                >
                  <div class="entry-header">
                    <span class="entry-key">{{ entry.key }}</span>
                    <p v-if="entry.description" class="entry-desc">{{ entry.description }}</p>
                  </div>
                  <div class="entry-control">
                    <Cmz_Switch
                      v-if="entry.valueType === 'boolean'"
                      :model-value="entry.value === 'true'"
                      @update:model-value="updateBoolean(entry, $event)"
                    />
                    <Cmz_Select
                      v-else-if="entry.valueType === 'gamemode'"
                      :model-value="entry.value"
                      :options="gamemodeOptions"
                      class="config-property-control"
                      @update:model-value="updateSelect(entry, $event)"
                    />
                    <Cmz_Select
                      v-else-if="entry.valueType === 'difficulty'"
                      :model-value="entry.value"
                      :options="difficultyOptions"
                      class="config-property-control"
                      @update:model-value="updateSelect(entry, $event)"
                    />
                    <Cmz_Input
                      v-else
                      class="config-property-control"
                      :model-value="entry.value"
                      :type="entry.valueType === 'number' ? 'number' : 'text'"
                      :step="entry.valueType === 'number' ? 1 : undefined"
                      :hide-number-controls="entry.valueType === 'number'"
                      :placeholder="entry.defaultValue"
                      :invalid="
                        entry.valueType === 'number' && !/^-?\d+$/u.test(entry.value.trim())
                      "
                      @update:model-value="updateProperty(entry, $event)"
                    />
                    <small
                      v-if="entry.valueType === 'number' && !/^-?\d+$/u.test(entry.value.trim())"
                      class="entry-error"
                    >
                      请输入整数
                    </small>
                  </div>
                </article>
                <div v-if="filteredPropertyEntries.length === 0" class="empty-state">
                  <span>没有匹配的属性。</span>
                </div>
              </div>
            </template>

            <div v-else class="source-editor-wrap">
              <div class="source-file-heading">
                <div>
                  <strong>{{ selectedFile.name }}</strong>
                  <span>{{ selectedFile.path }}</span>
                </div>
                <Cmz_Badge :text="fileKindLabel(selectedFile)" size="small" />
              </div>
              <ConfigSourceEditor
                :key="selectedFile.path"
                :model-value="selectedDraft.content"
                :kind="selectedFile.kind"
                @update:model-value="updateSource"
              />
            </div>
          </template>
        </template>
      </template>

      <template v-else>
        <div v-if="catalogLoading" class="loading-state">
          <Cmz_Spinner size="lg" />
          <span>正在扫描插件配置…</span>
        </div>

        <div v-else-if="!catalog?.plugins.length" class="empty-state">
          <FolderCog :size="30" :stroke-width="1.5" />
          <strong>
            {{ catalog?.pluginSupported ? "尚未发现插件配置文件" : "当前核心不提供插件配置能力" }}
          </strong>
          <span v-if="catalog?.pluginSupported"> 插件首次运行后会在 plugins 目录生成配置。 </span>
        </div>

        <div v-else class="plugins-container">
          <div class="plugins-header">
            <h3>服务器插件</h3>
          </div>
          <div class="plugin-list-view">
            <article
              v-for="plugin in catalog.plugins"
              :key="plugin.name"
              class="plugin-list-item"
              :class="{ expanded: selectedPluginName === plugin.name }"
              @click="selectPlugin(plugin.name)"
            >
              <div class="plugin-list-icon">{{ plugin.name.charAt(0).toUpperCase() }}</div>
              <div class="plugin-list-info">
                <div class="plugin-list-header">
                  <h4>{{ plugin.name }}</h4>
                  <span class="config-badge">
                    <Settings :size="14" />
                    {{ plugin.files.length }} 个配置文件
                  </span>
                </div>
                <div v-if="selectedPluginName === plugin.name" class="plugin-list-details">
                  <div class="plugin-config-section">
                    <div class="plugin-config-section-header">
                      <h5>配置文件</h5>
                    </div>
                    <div class="plugin-config-files-list">
                      <div
                        v-for="file in plugin.files"
                        :key="file.path"
                        class="plugin-config-file-item"
                        :class="{ active: selectedPath === file.path }"
                        role="button"
                        tabindex="0"
                        @click.stop="selectFile(file)"
                        @keydown.enter.stop="selectFile(file)"
                        @keydown.space.prevent.stop="selectFile(file)"
                      >
                        <FileText :size="16" />
                        <div class="plugin-config-file-copy">
                          <strong>{{ file.name }}</strong>
                          <span>{{ file.path }}</span>
                        </div>
                        <span class="plugin-config-file-type">{{ fileKindLabel(file) }}</span>
                        <Cmz_Button variant="outline" size="sm" @click.stop="selectFile(file)">
                          <Edit :size="14" />
                          打开
                        </Cmz_Button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </article>
          </div>

          <div
            v-if="selectedFile?.scope === 'plugin' && selectedDraft"
            class="plugin-source-editor"
          >
            <div class="source-file-heading">
              <div>
                <strong>{{ selectedFile.name }}</strong>
                <span>{{ selectedFile.path }}</span>
              </div>
              <Cmz_Badge :text="fileKindLabel(selectedFile)" size="small" />
            </div>
            <div class="restart-notice">
              <AlertTriangle :size="16" />
              <span>插件通常只在服务器启动时读取配置；保存后建议重启服务器。</span>
            </div>
            <ConfigSourceEditor
              :key="selectedFile.path"
              :model-value="selectedDraft.content"
              :kind="selectedFile.kind"
              @update:model-value="updateSource"
            />
          </div>
        </div>
      </template>

      <div
        v-if="selectedDraft && selectedFile"
        class="configuration-actions"
        :class="{ 'configuration-actions--unsaved': hasUnsavedChanges }"
      >
        <span class="floating-status">{{ saveStatusText }}</span>
        <div class="floating-actions-group">
          <Cmz_Tooltip content="重新载入当前配置" placement="top">
            <Cmz_Button
              variant="outline"
              size="sm"
              icon-only
              aria-label="重新载入当前配置"
              @click="reloadSelectedDocument"
            >
              <RefreshCw :size="16" />
            </Cmz_Button>
          </Cmz_Tooltip>
          <Cmz_Tooltip content="保存配置" placement="top">
            <Cmz_Button
              size="sm"
              icon-only
              aria-label="保存配置"
              :loading="saving"
              :disabled="!hasUnsavedChanges || invalidNumericKeys.length > 0"
              @click="openSavePreview"
            >
              <span
                class="save-icon-wrap"
                :class="{ 'save-icon-wrap--unsaved': hasUnsavedChanges }"
              >
                <Save :size="16" />
              </span>
            </Cmz_Button>
          </Cmz_Tooltip>
        </div>
      </div>

      <Cmz_Modal
        :visible="previewOpen && !!selectedDraft && !!selectedFile"
        title="确认配置修改"
        width="1040px"
        :close-on-overlay="!saving"
        @close="previewOpen = false"
        @update:visible="previewOpen = $event"
      >
        <div v-if="selectedDraft && selectedFile" class="source-diff-block">
          <div class="source-diff-title-row">
            <span class="source-diff-server">{{ selectedInstance.name }}</span>
            <span class="source-diff-path">{{ selectedDraft.document.path }}</span>
            <span>原文件 → 保存结果</span>
            <span class="diff-count diff-count-add">+{{ addedLineCount }}</span>
            <span class="diff-count diff-count-del">−{{ deletedLineCount }}</span>
          </div>
          <ConfigSourceDiffView :lines="configurationDiffLines" :kind="selectedFile.kind" />
          <p class="save-safeguard">保存时会先写入 SeaShard 备份，并校验文件未被外部修改。</p>
        </div>
        <template #footer>
          <div class="modal-actions">
            <Cmz_Button variant="outline" :disabled="saving" @click="previewOpen = false">
              取消
            </Cmz_Button>
            <Cmz_Button :loading="saving" @click="confirmSave">确认保存</Cmz_Button>
          </div>
        </template>
      </Cmz_Modal>

      <Cmz_Modal
        :visible="reloadConfirmOpen"
        title="放弃未保存修改？"
        width="440px"
        @close="reloadConfirmOpen = false"
        @update:visible="reloadConfirmOpen = $event"
      >
        <div class="discard-confirm-content">
          <span class="discard-confirm-icon"><AlertTriangle :size="21" /></span>
          <p>重新载入会丢弃当前文件尚未保存的修改，此操作无法撤销。</p>
        </div>
        <template #footer>
          <div class="modal-actions">
            <Cmz_Button variant="outline" @click="reloadConfirmOpen = false">继续编辑</Cmz_Button>
            <Cmz_Button color="#ef4444" @click="confirmReload">放弃并重新载入</Cmz_Button>
          </div>
        </template>
      </Cmz_Modal>
    </template>
  </section>
</template>

<style scoped src="./ServerConfigurationPage.css"></style>
