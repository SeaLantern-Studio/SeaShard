<script setup lang="ts">
import {
  agentModelMaximumContextTokensLimit,
  agentModelMaximumReasoningLevels,
  defaultAgentModelMaximumContextTokens,
  defaultAgentModelReasoningLevels,
  type AgentModelConfigurationClientService,
  type AgentModelConfigurationSnapshot,
  type AgentModelConnectionConfig,
  type AgentModelConnectionModel,
  type AgentModelConnectionMutation,
  type AgentModelSettings,
} from "@seashard/contracts";
import type { JsonObject, JsonValue } from "@seashard/plugin-sdk";
import {
  Cmz_Button,
  Cmz_Input,
  Cmz_Select,
  Cmz_Spinner,
  Cmz_Toast,
  useToast,
} from "cmzya-modern-ui";
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  FileCode2,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import "./AgentProviderSettingsPage.css";

const props = defineProps<{
  configuration: AgentModelConfigurationClientService;
}>();

interface ModelEditorRow {
  readonly key: number;
  displayName: string;
  id: string;
  maximumContextTokens: string;
  reasoningLevelsText: string;
  settingsOpen: boolean;
}

const toast = useToast();
const snapshot = shallowRef<AgentModelConfigurationSnapshot>();
const loading = ref(true);
const refreshing = ref(false);
const saving = ref(false);
const discovering = ref(false);
const editorOpen = ref(false);
const editingConnectionId = ref<string>();
const deleteTarget = shallowRef<AgentModelConnectionConfig>();
/** 表单固定打开时的版本与凭据引用，实时事件只能刷新列表，不能替旧表单取得新 revision。 */
const editorRevision = ref<string>();
const editorCredentialId = ref<string>();
const credentialTarget = shallowRef<AgentModelConnectionConfig>();
const resetConfirmationOpen = ref(false);
const connectionId = ref("");
const displayName = ref("");
const providerType = ref("");
const baseURL = ref("");
const credentialValue = ref("");
const modelRows = ref<ModelEditorRow[]>([]);
const advancedSettingsText = ref("{}");
let modelRowSequence = 0;
let disposed = false;
let disposeConfigurationChanged: (() => void) | undefined;

const providerOptions = computed(() =>
  (snapshot.value?.providerTypes ?? []).map((type) => ({
    label: type.displayName,
    value: type.id,
  })),
);
const selectedProviderType = computed(() =>
  snapshot.value?.providerTypes.find((type) => type.id === providerType.value),
);
const editorTitle = computed(() =>
  editingConnectionId.value ? "编辑模型供应商" : "添加模型供应商",
);
const requiresRecovery = computed(
  () => Boolean(snapshot.value?.diagnostics.length) && snapshot.value?.connections.length === 0,
);

onMounted(() => {
  disposeConfigurationChanged = props.configuration.onConfigurationChanged((next) => {
    if (!disposed) snapshot.value = next;
  });
  void refresh(false);
});

onBeforeUnmount(() => {
  disposed = true;
  credentialValue.value = "";
  disposeConfigurationChanged?.();
});

async function refresh(showToast = true): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    snapshot.value = await props.configuration.getConfiguration();
    if (showToast) toast.success({ title: "模型配置已刷新" });
  } catch (error) {
    toast.error({ title: "读取模型配置失败", description: errorMessage(error) });
  } finally {
    if (!disposed) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

function openCreateEditor(): void {
  editorRevision.value = snapshot.value?.revision;
  editorCredentialId.value = undefined;
  editingConnectionId.value = undefined;
  connectionId.value = "";
  displayName.value = "";
  providerType.value = providerOptions.value[0]?.value ?? "";
  baseURL.value = "";
  credentialValue.value = "";
  replaceModelRows([]);
  advancedSettingsText.value = "{}";
  editorOpen.value = true;
}

function openEditEditor(connection: AgentModelConnectionConfig): void {
  editingConnectionId.value = connection.id;
  editorRevision.value = snapshot.value?.revision;
  editorCredentialId.value = connection.credentialId;
  connectionId.value = connection.id;
  displayName.value = connection.displayName ?? "";
  providerType.value = connection.providerType;
  const { baseURL: currentBaseURL, ...advancedSettings } = connection.settings;
  baseURL.value = typeof currentBaseURL === "string" ? currentBaseURL : "";
  credentialValue.value = "";
  replaceModelRows(connection.models ?? []);
  advancedSettingsText.value = JSON.stringify(advancedSettings, null, 2);
  editorOpen.value = true;
}

function closeEditor(): void {
  if (saving.value || discovering.value) return;
  credentialValue.value = "";
  editorRevision.value = undefined;
  editorCredentialId.value = undefined;
  editorOpen.value = false;
}

function updateText(
  target: "connectionId" | "displayName" | "baseURL" | "credentialValue",
  value: string | number,
): void {
  const text = String(value);
  if (target === "connectionId") connectionId.value = text;
  if (target === "displayName") displayName.value = text;
  if (target === "baseURL") baseURL.value = text;
  if (target === "credentialValue") credentialValue.value = text;
}

function updateProviderType(value: string | number): void {
  if (typeof value === "string") providerType.value = value;
}

function createModelRow(model?: AgentModelConnectionModel): ModelEditorRow {
  modelRowSequence += 1;
  return {
    key: modelRowSequence,
    displayName: model?.displayName ?? "",
    id: model?.id ?? "",
    maximumContextTokens: String(
      model?.settings?.maximumContextTokens ?? defaultAgentModelMaximumContextTokens,
    ),
    reasoningLevelsText: (
      model?.settings?.reasoningLevels ?? defaultAgentModelReasoningLevels
    ).join(", "),
    settingsOpen: false,
  };
}

function replaceModelRows(models: readonly AgentModelConnectionModel[]): void {
  modelRows.value = models.length
    ? models.map((model) => createModelRow(model))
    : [createModelRow()];
}

function addModelRow(): void {
  modelRows.value.push(createModelRow());
}

function removeModelRow(key: number): void {
  modelRows.value = modelRows.value.filter((row) => row.key !== key);
}

function updateModelRow(
  row: ModelEditorRow,
  field: "displayName" | "id" | "maximumContextTokens" | "reasoningLevelsText",
  value: string | number,
): void {
  row[field] = String(value);
}

function toggleModelSettings(row: ModelEditorRow): void {
  row.settingsOpen = !row.settingsOpen;
}

function updateTextarea(event: Event): void {
  if (event.target instanceof HTMLTextAreaElement) {
    advancedSettingsText.value = event.target.value;
  }
}

/** 表单只编辑公共 baseURL；其余 Provider Type 专属参数保持在独立 JSON 对象中。 */
function createSettings(): JsonObject {
  if (!providerType.value) throw new Error("请选择供应商类型");
  let advanced: unknown;
  try {
    advanced = JSON.parse(advancedSettingsText.value || "{}") as unknown;
  } catch {
    throw new Error("高级设置必须是有效的 JSON 对象");
  }
  if (!advanced || typeof advanced !== "object" || Array.isArray(advanced)) {
    throw new Error("高级设置必须是 JSON 对象");
  }
  const settings = { ...(advanced as JsonObject) };
  const normalizedBaseURL = baseURL.value.trim();
  if (normalizedBaseURL) settings.baseURL = normalizedBaseURL;
  else delete settings.baseURL;
  if (providerType.value === "openai-compatible" && !normalizedBaseURL) {
    throw new Error("OpenAI Compatible 必须填写 Base URL");
  }
  return settings;
}

function parseModels(): AgentModelConnectionModel[] {
  const models: AgentModelConnectionModel[] = [];
  const seen = new Set<string>();
  for (const [index, row] of modelRows.value.entries()) {
    const id = row.id.trim();
    const modelDisplayName = row.displayName.trim();
    if (!id && !modelDisplayName) continue;
    if (!id) throw new Error(`第 ${index + 1} 个模型缺少模型 ID`);
    if (seen.has(id)) throw new Error(`模型 ID 重复：${id}`);
    seen.add(id);
    models.push({
      id,
      ...(modelDisplayName ? { displayName: modelDisplayName } : {}),
      settings: parseModelSettings(row, index),
    });
  }
  if (!models.length && !selectedProviderType.value?.catalog?.length) {
    throw new Error("至少添加一个模型，或先从供应商发现模型");
  }
  return models;
}

/** 设置页用可读的逗号列表编辑档位，保存时收敛为稳定、去重的字符串数组。 */
function parseModelSettings(row: ModelEditorRow, index: number): AgentModelSettings {
  const maximumContextTokens = Number(row.maximumContextTokens.trim());
  if (
    !Number.isSafeInteger(maximumContextTokens) ||
    maximumContextTokens <= 0 ||
    maximumContextTokens > agentModelMaximumContextTokensLimit
  ) {
    throw new Error(
      `第 ${index + 1} 个模型的最大上下文必须是 1 到 ${agentModelMaximumContextTokensLimit} 的整数`,
    );
  }
  const reasoningLevels = row.reasoningLevelsText
    .split(/[,，\n]/u)
    .map((level) => level.trim())
    .filter(Boolean);
  if (reasoningLevels.length === 0 || reasoningLevels.length > agentModelMaximumReasoningLevels) {
    throw new Error(
      `第 ${index + 1} 个模型必须配置 1 到 ${agentModelMaximumReasoningLevels} 个推理档位`,
    );
  }
  const uniqueLevels = [...new Set(reasoningLevels)];
  if (uniqueLevels.length !== reasoningLevels.length) {
    throw new Error(`第 ${index + 1} 个模型包含重复的推理档位`);
  }
  if (uniqueLevels.some((level) => level.length > 64)) {
    throw new Error(`第 ${index + 1} 个模型的推理档位名称不能超过 64 个字符`);
  }
  return { maximumContextTokens, reasoningLevels: uniqueLevels };
}

function normalizedConnectionId(): string {
  const id = connectionId.value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) {
    throw new Error("连接 ID 只能包含字母、数字、点、下划线和连字符");
  }
  return id;
}

function credentialIdFor(existingCredentialId: string | undefined, id: string): string {
  return existingCredentialId ?? `agent.connection.${id}`;
}

async function discoverModels(): Promise<void> {
  if (discovering.value || saving.value) return;
  let settings: JsonObject;
  let id: string;
  try {
    settings = createSettings();
    id = normalizedConnectionId();
  } catch (error) {
    toast.error({ title: "无法发现模型", description: errorMessage(error) });
    return;
  }
  const credentialId = credentialIdFor(editorCredentialId.value, id);
  discovering.value = true;
  try {
    const candidateCredential = credentialValue.value.trim()
      ? { credentialValue: credentialValue.value }
      : editorCredentialId.value
        ? { credentialId }
        : {};
    const models = await props.configuration.discoverModels({
      providerType: providerType.value,
      settings,
      ...candidateCredential,
    });
    replaceModelRows(models);
    toast.success({ title: `已发现 ${models.length} 个模型` });
  } catch (error) {
    toast.error({ title: "模型发现失败", description: errorMessage(error) });
  } finally {
    if (!disposed) discovering.value = false;
  }
}

/** 配置先落盘，再写入独立凭据；第二阶段失败时必须准确保留并反馈部分成功状态。 */
async function saveConnection(): Promise<void> {
  const expectedRevision = editorRevision.value;
  if (!expectedRevision || saving.value) return;
  let id: string;
  let settings: JsonObject;
  let models: AgentModelConnectionModel[];
  try {
    id = normalizedConnectionId();
    settings = createSettings();
    models = parseModels();
  } catch (error) {
    toast.error({ title: "无法保存供应商", description: errorMessage(error) });
    return;
  }
  const editingExisting = Boolean(editingConnectionId.value);
  const credentialId = credentialIdFor(editorCredentialId.value, id);
  const hasCredentialUpdate = Boolean(credentialValue.value.trim());
  const operations: AgentModelConnectionMutation[] = [
    { op: "set", path: ["providerType"], value: providerType.value },
    { op: "set", path: ["settings"], value: settings },
    models.length
      ? { op: "set", path: ["models"], value: models as unknown as JsonValue }
      : { op: "unset", path: ["models"] },
    displayName.value.trim()
      ? { op: "set", path: ["displayName"], value: displayName.value.trim() }
      : { op: "unset", path: ["displayName"] },
    editorCredentialId.value || hasCredentialUpdate
      ? { op: "set", path: ["credentialId"], value: credentialId }
      : { op: "unset", path: ["credentialId"] },
  ];

  saving.value = true;
  let configurationSaved = false;
  try {
    const nextConfiguration = await props.configuration.mutateConnection({
      expectedRevision,
      connectionId: id,
      operations,
    });
    snapshot.value = nextConfiguration;
    editorRevision.value = nextConfiguration.revision;
    configurationSaved = true;
    if (hasCredentialUpdate) {
      snapshot.value = await props.configuration.writeCredential({
        credentialId,
        value: credentialValue.value,
      });
    }
    credentialValue.value = "";
    editorRevision.value = undefined;
    editorCredentialId.value = undefined;
    editorOpen.value = false;
    toast.success({ title: editingExisting ? "模型供应商已更新" : "模型供应商已添加" });
  } catch (error) {
    toast.error({
      title:
        configurationSaved && hasCredentialUpdate
          ? "供应商配置已保存，但凭据保存失败"
          : "保存模型供应商失败",
      description: errorMessage(error),
    });
    await refresh(false);
  } finally {
    if (!disposed) saving.value = false;
  }
}

async function removeCredential(): Promise<void> {
  const connection = credentialTarget.value;
  if (!connection?.credentialId || saving.value) return;
  saving.value = true;
  try {
    snapshot.value = await props.configuration.removeCredential({
      credentialId: connection.credentialId,
    });
    credentialTarget.value = undefined;
    toast.success({ title: "供应商凭据已移除" });
  } catch (error) {
    toast.error({ title: "移除供应商凭据失败", description: errorMessage(error) });
  } finally {
    if (!disposed) saving.value = false;
  }
}

async function removeConnection(): Promise<void> {
  const current = snapshot.value;
  const target = deleteTarget.value;
  if (!current || !target || saving.value) return;
  saving.value = true;
  try {
    snapshot.value = await props.configuration.removeConnection({
      expectedRevision: current.revision,
      connectionId: target.id,
    });
    if (target.credentialId && target.credentialConfigured) {
      try {
        snapshot.value = await props.configuration.removeCredential({
          credentialId: target.credentialId,
        });
      } catch (error) {
        deleteTarget.value = undefined;
        toast.error({
          title: "供应商已删除，但凭据清理失败",
          description: errorMessage(error),
        });
        return;
      }
    }
    deleteTarget.value = undefined;
    toast.success({ title: "模型供应商已删除" });
  } catch (error) {
    toast.error({ title: "删除模型供应商失败", description: errorMessage(error) });
    await refresh(false);
  } finally {
    if (!disposed) saving.value = false;
  }
}

async function resetConfiguration(): Promise<void> {
  const current = snapshot.value;
  if (!current || saving.value) return;
  saving.value = true;
  try {
    snapshot.value = await props.configuration.resetConfiguration({
      expectedRevision: current.revision,
    });
    resetConfirmationOpen.value = false;
    toast.success({ title: "模型配置已重置" });
  } catch (error) {
    toast.error({ title: "重置模型配置失败", description: errorMessage(error) });
    await refresh(false);
  } finally {
    if (!disposed) saving.value = false;
  }
}

async function openConfigurationFile(): Promise<void> {
  try {
    await props.configuration.openConfigurationFile();
  } catch (error) {
    toast.error({ title: "打开模型配置失败", description: errorMessage(error) });
  }
}

function providerName(id: string): string {
  return snapshot.value?.providerTypes.find((provider) => provider.id === id)?.displayName ?? id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section class="agent-settings-page" aria-label="供应商">
    <Cmz_Toast position="top-right" />

    <header v-if="!editorOpen" class="agent-settings-header">
      <div class="agent-settings-title">
        <h1>供应商</h1>
        <span v-if="snapshot && !loading" class="provider-count">
          {{ snapshot.connections.length }}
        </span>
      </div>
      <div class="agent-settings-actions">
        <Cmz_Button variant="outline" size="sm" :disabled="loading" @click="refresh()">
          <RefreshCw :size="16" :stroke-width="1.8" />
          刷新
        </Cmz_Button>
        <Cmz_Button variant="outline" size="sm" @click="openConfigurationFile">
          <FileCode2 :size="16" :stroke-width="1.8" />
          打开配置文件
        </Cmz_Button>
        <Cmz_Button size="sm" :disabled="loading" @click="openCreateEditor">
          <Plus :size="16" :stroke-width="1.8" />
          添加供应商
        </Cmz_Button>
      </div>
    </header>

    <div v-if="!editorOpen && loading" class="agent-settings-loading">
      <Cmz_Spinner size="lg" />
    </div>

    <template v-else-if="!editorOpen && snapshot">
      <section v-if="snapshot.diagnostics.length" class="configuration-diagnostic" role="alert">
        <AlertTriangle :size="20" :stroke-width="1.8" />
        <div class="configuration-diagnostic-content">
          <strong>模型配置需要处理</strong>
          <ul>
            <li v-for="diagnostic in snapshot.diagnostics" :key="diagnostic">{{ diagnostic }}</li>
          </ul>
        </div>
        <Cmz_Button
          v-if="requiresRecovery"
          variant="outline"
          size="sm"
          @click="resetConfirmationOpen = true"
        >
          重置配置
        </Cmz_Button>
      </section>

      <div v-if="snapshot.connections.length" class="provider-list" aria-label="供应商列表">
        <article
          v-for="connection in snapshot.connections"
          :key="connection.id"
          class="provider-row"
        >
          <div class="provider-row-main">
            <div class="provider-identity">
              <span class="provider-mark" aria-hidden="true">
                <Bot :size="19" :stroke-width="1.8" />
              </span>
              <div>
                <div class="provider-title-row">
                  <h3>{{ connection.displayName || connection.id }}</h3>
                  <span
                    class="provider-state"
                    :class="connection.available ? 'is-available' : 'is-unavailable'"
                  >
                    {{ connection.available ? "已加载" : "未加载" }}
                  </span>
                </div>
                <div class="provider-meta">
                  <code>{{ connection.id }}</code>
                  <span>{{ providerName(connection.providerType) }}</span>
                  <span>{{ connection.models?.length ?? 0 }} 个模型</span>
                </div>
              </div>
            </div>

            <div class="provider-row-actions">
              <button
                v-if="connection.credentialConfigured"
                type="button"
                class="provider-icon-button"
                title="移除凭据"
                aria-label="移除凭据"
                :disabled="saving"
                @click="credentialTarget = connection"
              >
                <KeyRound :size="17" :stroke-width="1.8" />
              </button>
              <button
                type="button"
                class="provider-icon-button"
                title="编辑供应商"
                aria-label="编辑供应商"
                @click="openEditEditor(connection)"
              >
                <Pencil :size="17" :stroke-width="1.8" />
              </button>
              <button
                type="button"
                class="provider-icon-button is-danger"
                title="删除供应商"
                aria-label="删除供应商"
                @click="deleteTarget = connection"
              >
                <Trash2 :size="17" :stroke-width="1.8" />
              </button>
            </div>
          </div>

          <div v-if="connection.diagnostic" class="provider-diagnostic">
            <AlertTriangle :size="15" :stroke-width="1.8" />
            <span>{{ connection.diagnostic }}</span>
          </div>

          <div v-if="connection.models?.length" class="model-chip-list" aria-label="模型列表">
            <span v-for="model in connection.models" :key="model.id" class="model-chip">
              {{ model.displayName || model.id }}
            </span>
          </div>
        </article>
      </div>

      <button v-else type="button" class="provider-empty" @click="openCreateEditor">
        <span class="provider-empty-icon"><Plus :size="22" :stroke-width="1.8" /></span>
        <strong>添加第一个模型供应商</strong>
      </button>
    </template>

    <form v-if="editorOpen" class="provider-editor-page" @submit.prevent="saveConnection">
      <header class="agent-settings-header">
        <h1>{{ editorTitle }}</h1>
        <div class="agent-settings-actions">
          <Cmz_Button
            type="button"
            variant="outline"
            size="sm"
            :disabled="saving || discovering"
            @click="closeEditor"
          >
            取消
          </Cmz_Button>
          <Cmz_Button type="submit" size="sm" :loading="saving" :disabled="discovering">
            保存
          </Cmz_Button>
        </div>
      </header>

      <div class="provider-form-grid">
        <label class="provider-field">
          <span>连接 ID</span>
          <Cmz_Input
            :model-value="connectionId"
            :disabled="Boolean(editingConnectionId) || saving || discovering"
            placeholder="例如 company-gateway"
            :spellcheck="false"
            @update:model-value="updateText('connectionId', $event)"
          />
        </label>

        <label class="provider-field">
          <span>显示名称</span>
          <Cmz_Input
            :model-value="displayName"
            :disabled="saving || discovering"
            placeholder="可选"
            @update:model-value="updateText('displayName', $event)"
          />
        </label>

        <label class="provider-field">
          <span>供应商类型</span>
          <Cmz_Select
            :model-value="providerType"
            :options="providerOptions"
            :disabled="saving || discovering"
            @update:model-value="updateProviderType"
          />
        </label>

        <label class="provider-field">
          <span>Base URL</span>
          <Cmz_Input
            :model-value="baseURL"
            :disabled="saving || discovering"
            placeholder="使用官方地址时可留空"
            :spellcheck="false"
            @update:model-value="updateText('baseURL', $event)"
          />
        </label>

        <label class="provider-field provider-field-wide">
          <span>API Key</span>
          <div class="credential-field-control">
            <Cmz_Input
              type="password"
              :model-value="credentialValue"
              :disabled="saving || discovering"
              placeholder=""
              :spellcheck="false"
              autocomplete="new-password"
              @update:model-value="updateText('credentialValue', $event)"
            />
            <span v-if="!credentialValue" class="credential-placeholder" aria-hidden="true">
              <span>
                {{ editingConnectionId ? "留空则保持现有凭据" : "无凭据的服务可留空" }}
              </span>
            </span>
          </div>
        </label>

        <div class="provider-field provider-field-wide model-editor">
          <div class="model-editor-heading">
            <span>模型</span>
            <div class="model-editor-actions">
              <Cmz_Button
                v-if="selectedProviderType?.supportsModelDiscovery"
                type="button"
                variant="outline"
                size="sm"
                :loading="discovering"
                :disabled="saving"
                @click="discoverModels"
              >
                <Search :size="15" :stroke-width="1.8" />
                发现模型
              </Cmz_Button>
              <Cmz_Button
                type="button"
                variant="outline"
                size="sm"
                :disabled="saving || discovering"
                @click="addModelRow"
              >
                <Plus :size="15" :stroke-width="1.8" />
                添加模型
              </Cmz_Button>
            </div>
          </div>

          <div class="model-row-list">
            <div class="model-column-headings" aria-hidden="true">
              <span>模型名称</span>
              <span>模型 ID</span>
              <span></span>
            </div>
            <div v-for="row in modelRows" :key="row.key" class="model-editor-item">
              <div class="model-editor-row">
                <Cmz_Input
                  :model-value="row.displayName"
                  :disabled="saving || discovering"
                  placeholder="例如 GPT 5.6 Luna"
                  aria-label="模型名称"
                  @update:model-value="updateModelRow(row, 'displayName', $event)"
                />
                <Cmz_Input
                  :model-value="row.id"
                  :disabled="saving || discovering"
                  placeholder="例如 gpt-5.6-luna"
                  aria-label="模型 ID"
                  :spellcheck="false"
                  @update:model-value="updateModelRow(row, 'id', $event)"
                />
                <button
                  type="button"
                  class="provider-icon-button is-danger"
                  title="删除模型"
                  aria-label="删除模型"
                  :disabled="saving || discovering"
                  @click="removeModelRow(row.key)"
                >
                  <Trash2 :size="17" :stroke-width="1.8" />
                </button>
              </div>

              <button
                type="button"
                class="model-settings-toggle"
                :aria-expanded="row.settingsOpen"
                :aria-controls="`model-settings-${row.key}`"
                :disabled="saving || discovering"
                @click="toggleModelSettings(row)"
              >
                <ChevronDown
                  :size="14"
                  :stroke-width="1.8"
                  :class="{ 'is-open': row.settingsOpen }"
                />
                <span>模型设置</span>
              </button>

              <div
                v-if="row.settingsOpen"
                :id="`model-settings-${row.key}`"
                class="model-settings-panel"
              >
                <div class="model-settings-headings" aria-hidden="true">
                  <span>设置项名</span>
                  <span>设置值</span>
                </div>
                <label class="model-setting-row">
                  <span>最大上下文</span>
                  <Cmz_Input
                    type="number"
                    :model-value="row.maximumContextTokens"
                    :disabled="saving || discovering"
                    :min="1"
                    :max="agentModelMaximumContextTokensLimit"
                    :step="1000"
                    aria-label="最大上下文 Token"
                    @update:model-value="updateModelRow(row, 'maximumContextTokens', $event)"
                  />
                </label>
                <label class="model-setting-row">
                  <span>推理程度</span>
                  <Cmz_Input
                    :model-value="row.reasoningLevelsText"
                    :disabled="saving || discovering"
                    placeholder="low, medium, high, xhigh, max, ultra"
                    aria-label="推理程度档位"
                    :spellcheck="false"
                    @update:model-value="updateModelRow(row, 'reasoningLevelsText', $event)"
                  />
                </label>
              </div>
            </div>
          </div>
        </div>

        <label class="provider-field provider-field-wide">
          <span>高级设置</span>
          <textarea
            class="provider-textarea provider-settings-json"
            :value="advancedSettingsText"
            :disabled="saving || discovering"
            rows="5"
            :spellcheck="false"
            @input="updateTextarea"
          ></textarea>
        </label>
      </div>
    </form>

    <div
      v-if="credentialTarget"
      class="agent-modal-layer"
      @click.self="credentialTarget = undefined"
    >
      <section class="agent-modal agent-confirmation" role="alertdialog" aria-modal="true">
        <header class="agent-modal-header">
          <h2>移除供应商凭据</h2>
          <button
            type="button"
            class="agent-modal-close"
            aria-label="关闭"
            @click="credentialTarget = undefined"
          >
            <X :size="19" :stroke-width="1.8" />
          </button>
        </header>
        <p>确认移除“{{ credentialTarget.displayName || credentialTarget.id }}”保存的凭据。</p>
        <footer class="agent-modal-footer">
          <span class="agent-modal-footer-spacer"></span>
          <Cmz_Button variant="outline" size="sm" @click="credentialTarget = undefined">
            取消
          </Cmz_Button>
          <Cmz_Button size="sm" :loading="saving" @click="removeCredential">移除</Cmz_Button>
        </footer>
      </section>
    </div>

    <div v-if="deleteTarget" class="agent-modal-layer" @click.self="deleteTarget = undefined">
      <section class="agent-modal agent-confirmation" role="alertdialog" aria-modal="true">
        <header class="agent-modal-header">
          <h2>删除模型供应商</h2>
          <button
            type="button"
            class="agent-modal-close"
            aria-label="关闭"
            @click="deleteTarget = undefined"
          >
            <X :size="19" :stroke-width="1.8" />
          </button>
        </header>
        <p>确认删除“{{ deleteTarget.displayName || deleteTarget.id }}”的连接配置。</p>
        <footer class="agent-modal-footer">
          <span class="agent-modal-footer-spacer"></span>
          <Cmz_Button variant="outline" size="sm" @click="deleteTarget = undefined">
            取消
          </Cmz_Button>
          <Cmz_Button size="sm" :loading="saving" @click="removeConnection">删除</Cmz_Button>
        </footer>
      </section>
    </div>

    <div
      v-if="resetConfirmationOpen"
      class="agent-modal-layer"
      @click.self="resetConfirmationOpen = false"
    >
      <section class="agent-modal agent-confirmation" role="alertdialog" aria-modal="true">
        <header class="agent-modal-header">
          <h2>重置模型配置</h2>
          <button
            type="button"
            class="agent-modal-close"
            aria-label="关闭"
            @click="resetConfirmationOpen = false"
          >
            <X :size="19" :stroke-width="1.8" />
          </button>
        </header>
        <p>当前文件无法结构化读取。重置会以空模板覆盖 models.yml。</p>
        <footer class="agent-modal-footer">
          <span class="agent-modal-footer-spacer"></span>
          <Cmz_Button variant="outline" size="sm" @click="resetConfirmationOpen = false">
            取消
          </Cmz_Button>
          <Cmz_Button size="sm" :loading="saving" @click="resetConfiguration">重置</Cmz_Button>
        </footer>
      </section>
    </div>
  </section>
</template>
