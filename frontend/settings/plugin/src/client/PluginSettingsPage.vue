<script setup lang="ts">
import type {
  PluginManagementEntrySnapshot,
  PluginManagementService,
  PluginManagementSnapshot,
} from "@seashard/contracts";
import { Cmz_Button, Cmz_Spinner, Cmz_Switch, useToast } from "cmzya-modern-ui";
import {
  ArrowLeft,
  ChevronRight,
  Package,
  Puzzle,
  RefreshCw,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{
  management: PluginManagementService;
}>();

const toast = useToast();
const plugins = ref<readonly PluginManagementSnapshot[]>([]);
const selectedPluginId = ref<string>();
const loading = ref(true);
const refreshing = ref(false);
const loadFailed = ref(false);
const updatingPluginIds = ref<ReadonlySet<string>>(new Set());
const deleteTarget = ref<PluginManagementSnapshot>();
const deletingPluginId = ref<string>();
let disposed = false;
let refreshSequence = 0;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

const selectedPlugin = computed(() =>
  plugins.value.find(({ id }) => id === selectedPluginId.value),
);

onMounted(() => {
  void refresh(true);
  refreshTimer = setInterval(() => void refresh(false), 3_000);
});

onBeforeUnmount(() => {
  disposed = true;
  refreshSequence += 1;
  if (refreshTimer) clearInterval(refreshTimer);
});

/** 轮询仅同步 CLI 临时覆盖状态；后台失败不重复打扰用户。 */
async function refresh(reportFailure: boolean): Promise<void> {
  if (updatingPluginIds.value.size > 0) return;
  const sequence = ++refreshSequence;
  if (reportFailure) refreshing.value = true;
  try {
    const snapshot = await props.management.list();
    if (disposed || sequence !== refreshSequence) return;
    plugins.value = snapshot;
    loadFailed.value = false;
    if (selectedPluginId.value && !snapshot.some(({ id }) => id === selectedPluginId.value)) {
      selectedPluginId.value = undefined;
    }
  } catch (error) {
    if (disposed || sequence !== refreshSequence) return;
    loadFailed.value = plugins.value.length === 0;
    if (reportFailure) {
      toast.error({ title: "读取插件失败", description: errorMessage(error) });
    }
  } finally {
    if (!disposed && sequence === refreshSequence) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

async function setEnabled(plugin: PluginManagementSnapshot, enabled: boolean): Promise<void> {
  if (updatingPluginIds.value.has(plugin.id)) return;
  refreshSequence += 1;
  updatingPluginIds.value = new Set([...updatingPluginIds.value, plugin.id]);
  let failed = false;
  try {
    const updated = await props.management.setEnabled(plugin.id, enabled);
    if (disposed) return;
    plugins.value = plugins.value.map((candidate) =>
      candidate.id === updated.id ? updated : candidate,
    );
    toast.success({ title: enabled ? "插件已开启" : "插件已关闭" });
  } catch (error) {
    failed = true;
    if (!disposed) {
      toast.error({
        title: enabled ? "无法开启插件" : "无法关闭插件",
        description: errorMessage(error),
      });
    }
  } finally {
    if (!disposed) {
      const next = new Set(updatingPluginIds.value);
      next.delete(plugin.id);
      updatingPluginIds.value = next;
    }
  }
  if (failed && !disposed) await refresh(false);
}

function requestUninstall(plugin: PluginManagementSnapshot): void {
  if (plugin.source !== "installed" || updatingPluginIds.value.has(plugin.id)) return;
  deleteTarget.value = plugin;
}

function cancelUninstall(): void {
  if (!deletingPluginId.value) deleteTarget.value = undefined;
}

/** 删除属于显式用户操作；先失效轮询，再以 Host 返回为准移除卡片并发送通知。 */
async function confirmUninstall(): Promise<void> {
  const target = deleteTarget.value;
  if (!target || target.source !== "installed" || deletingPluginId.value) return;
  refreshSequence += 1;
  deletingPluginId.value = target.id;
  updatingPluginIds.value = new Set([...updatingPluginIds.value, target.id]);
  try {
    await props.management.uninstall(target.id);
    if (disposed) return;
    plugins.value = plugins.value.filter(({ id }) => id !== target.id);
    if (selectedPluginId.value === target.id) selectedPluginId.value = undefined;
    deleteTarget.value = undefined;
    toast.success({ title: "插件已删除" });
  } catch (error) {
    if (!disposed) {
      toast.error({ title: "删除插件失败", description: errorMessage(error) });
    }
  } finally {
    if (!disposed) {
      const next = new Set(updatingPluginIds.value);
      next.delete(target.id);
      updatingPluginIds.value = next;
      deletingPluginId.value = undefined;
    }
  }
}

function openDetails(pluginId: string): void {
  selectedPluginId.value = pluginId;
}

function sourceLabel(source: PluginManagementSnapshot["source"]): string {
  return source === "development" ? "临时加载" : "已安装";
}

function trustLabel(trust: PluginManagementSnapshot["trust"]): string {
  return trust === "local-full-trust" ? "本地完整信任" : "安装包完整信任";
}

function entryStateLabel(entry: PluginManagementEntrySnapshot): string {
  if (!entry.enabled) return "已关闭";
  if (entry.state === "failed") return "启动失败";
  if (entry.state === "active") return "运行中";
  return "未运行";
}

function activeEntryCount(plugin: PluginManagementSnapshot): number {
  return plugin.entries.filter(({ state }) => state === "active").length;
}

function entryUses(entry: PluginManagementEntrySnapshot): string {
  const contracts = Object.keys(entry.uses);
  return contracts.length ? contracts.join("、") : "无";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section class="plugin-settings-page" aria-label="插件设置">
    <template v-if="selectedPlugin">
      <header class="plugin-detail-toolbar">
        <Cmz_Button variant="outline" size="sm" @click="selectedPluginId = undefined">
          <ArrowLeft :size="16" :stroke-width="1.8" />
          返回
        </Cmz_Button>
        <div class="plugin-detail-toggle" @click.stop>
          <span>{{ selectedPlugin.enabled ? "已开启" : "已关闭" }}</span>
          <Cmz_Switch
            :model-value="selectedPlugin.enabled"
            :disabled="updatingPluginIds.has(selectedPlugin.id)"
            :aria-label="`${selectedPlugin.id} 开关`"
            @update:model-value="setEnabled(selectedPlugin, $event)"
          />
        </div>
      </header>

      <div class="plugin-detail-heading">
        <span class="plugin-mark" aria-hidden="true">
          <Terminal v-if="selectedPlugin.source === 'development'" :size="24" />
          <Package v-else :size="24" />
        </span>
        <h1>{{ selectedPlugin.id }}</h1>
        <span class="plugin-source" :class="`plugin-source--${selectedPlugin.source}`">
          {{ sourceLabel(selectedPlugin.source) }}
        </span>
      </div>

      <dl class="plugin-facts">
        <div>
          <dt>版本</dt>
          <dd>{{ selectedPlugin.version }}</dd>
        </div>
        <div>
          <dt>发布者</dt>
          <dd>{{ selectedPlugin.publisher }}</dd>
        </div>
        <div>
          <dt>信任方式</dt>
          <dd>{{ trustLabel(selectedPlugin.trust) }}</dd>
        </div>
        <div>
          <dt>加载时间</dt>
          <dd>{{ formatDate(selectedPlugin.installedAt) }}</dd>
        </div>
        <div class="plugin-digest-row">
          <dt>包摘要</dt>
          <dd>
            <code>{{ selectedPlugin.digest }}</code>
          </dd>
        </div>
      </dl>

      <section class="plugin-entry-section" aria-labelledby="plugin-entry-title">
        <h2 id="plugin-entry-title">插件入口</h2>
        <div class="plugin-entry-list">
          <article
            v-for="entry in selectedPlugin.entries"
            :key="entry.runtimeId"
            class="entry-card"
          >
            <header>
              <div class="entry-identity">
                <Puzzle :size="18" :stroke-width="1.8" />
                <strong>{{ entry.id }}</strong>
              </div>
              <span class="entry-state" :class="`entry-state--${entry.state}`">
                {{ entryStateLabel(entry) }}
              </span>
            </header>
            <dl>
              <div>
                <dt>运行环境</dt>
                <dd>{{ entry.runtime === "host" ? "Host" : "Client" }}</dd>
              </div>
              <div>
                <dt>Runtime ID</dt>
                <dd>
                  <code>{{ entry.runtimeId }}</code>
                </dd>
              </div>
              <div>
                <dt>Service 权限</dt>
                <dd>{{ entryUses(entry) }}</dd>
              </div>
            </dl>
            <div v-if="entry.error" class="entry-error">
              <TriangleAlert :size="16" :stroke-width="1.9" />
              <span>{{ entry.error }}</span>
            </div>
          </article>
        </div>
      </section>
    </template>

    <template v-else>
      <header class="plugin-list-heading">
        <h1>插件设置</h1>
        <Cmz_Button
          variant="outline"
          size="sm"
          :disabled="refreshing"
          aria-label="刷新插件列表"
          @click="refresh(true)"
        >
          <RefreshCw :size="16" :stroke-width="1.8" />
          刷新
        </Cmz_Button>
      </header>

      <div v-if="loading" class="plugin-page-state">
        <Cmz_Spinner size="lg" />
      </div>

      <div v-else-if="loadFailed" class="plugin-page-state plugin-page-state--error">
        <TriangleAlert :size="26" :stroke-width="1.8" />
        <strong>插件列表读取失败</strong>
        <Cmz_Button variant="outline" size="sm" @click="refresh(true)">重试</Cmz_Button>
      </div>

      <div v-else-if="plugins.length === 0" class="plugin-page-state">
        <Puzzle :size="30" :stroke-width="1.7" />
        <strong>暂无第三方插件</strong>
      </div>

      <div v-else class="plugin-grid">
        <article v-for="plugin in plugins" :key="plugin.id" class="plugin-card">
          <div
            class="plugin-card-main"
            role="button"
            tabindex="0"
            :aria-label="`查看 ${plugin.id} 详情`"
            @click="openDetails(plugin.id)"
            @keydown.enter="openDetails(plugin.id)"
            @keydown.space.prevent="openDetails(plugin.id)"
          >
            <header class="plugin-card-header">
              <span class="plugin-mark" aria-hidden="true">
                <Terminal v-if="plugin.source === 'development'" :size="22" />
                <Package v-else :size="22" />
              </span>
              <h2>{{ plugin.id }}</h2>
              <div class="plugin-card-switch" @click.stop @keydown.stop>
                <Cmz_Switch
                  :model-value="plugin.enabled"
                  :disabled="updatingPluginIds.has(plugin.id)"
                  :aria-label="`${plugin.id} 开关`"
                  @update:model-value="setEnabled(plugin, $event)"
                />
              </div>
            </header>

            <div class="plugin-card-badges">
              <span class="plugin-source" :class="`plugin-source--${plugin.source}`">
                {{ sourceLabel(plugin.source) }}
              </span>
              <span class="plugin-status" :class="{ 'plugin-status--disabled': !plugin.enabled }">
                {{ plugin.enabled ? "已开启" : "已关闭" }}
              </span>
            </div>

            <dl class="plugin-card-facts">
              <div>
                <dt>版本</dt>
                <dd>{{ plugin.version }}</dd>
              </div>
              <div>
                <dt>发布者</dt>
                <dd>{{ plugin.publisher }}</dd>
              </div>
              <div>
                <dt>入口</dt>
                <dd>{{ activeEntryCount(plugin) }}/{{ plugin.entries.length }} 运行中</dd>
              </div>
            </dl>
          </div>

          <footer>
            <Cmz_Button variant="ghost" size="sm" @click="openDetails(plugin.id)">
              插件详情
              <ChevronRight :size="17" :stroke-width="1.8" />
            </Cmz_Button>
            <Cmz_Button
              v-if="plugin.source === 'installed'"
              variant="ghost"
              size="sm"
              color="var(--sl-danger)"
              :disabled="updatingPluginIds.has(plugin.id)"
              :aria-label="`删除 ${plugin.id}`"
              @click="requestUninstall(plugin)"
            >
              <Trash2 :size="16" :stroke-width="1.8" />
              删除
            </Cmz_Button>
          </footer>
        </article>
      </div>
    </template>

    <div v-if="deleteTarget" class="plugin-delete-layer" @click.self="cancelUninstall">
      <section
        class="plugin-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="plugin-delete-title"
      >
        <header class="plugin-delete-header">
          <h2 id="plugin-delete-title">删除插件</h2>
          <button
            type="button"
            class="plugin-delete-close"
            :disabled="Boolean(deletingPluginId)"
            aria-label="关闭"
            @click="cancelUninstall"
          >
            <X :size="19" :stroke-width="1.8" />
          </button>
        </header>
        <div class="plugin-delete-body">
          <p>
            确认删除 <code>{{ deleteTarget.id }}</code
            >？全部已安装版本和运行绑定都会移除，插件产生的数据将保留。
          </p>
        </div>
        <footer class="plugin-delete-footer">
          <Cmz_Button
            variant="outline"
            size="sm"
            :disabled="Boolean(deletingPluginId)"
            @click="cancelUninstall"
          >
            取消
          </Cmz_Button>
          <Cmz_Button
            size="sm"
            color="var(--sl-danger)"
            :loading="deletingPluginId === deleteTarget.id"
            @click="confirmUninstall"
          >
            确认删除
          </Cmz_Button>
        </footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.plugin-settings-page {
  position: relative;
  width: min(100%, 980px);
  min-height: 100%;
  margin: 0 auto;
  padding-bottom: var(--sl-space-2xl);
}

.plugin-list-heading,
.plugin-detail-toolbar,
.plugin-detail-heading,
.plugin-detail-toggle,
.plugin-card-header,
.plugin-card-badges,
.plugin-card footer,
.plugin-delete-header,
.plugin-delete-footer,
.entry-card header,
.entry-identity,
.entry-error {
  display: flex;
  align-items: center;
}

.plugin-list-heading,
.plugin-detail-toolbar {
  min-height: 48px;
  justify-content: space-between;
  gap: var(--sl-space-md);
  margin-bottom: var(--sl-space-lg);
}

.plugin-list-heading h1,
.plugin-detail-heading h1,
.plugin-entry-section h2,
.plugin-card h2 {
  margin: 0;
  color: var(--sl-text-primary);
}

.plugin-list-heading h1,
.plugin-detail-heading h1 {
  font-size: 1.75rem;
  font-weight: 680;
  letter-spacing: -0.04em;
}

.plugin-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sl-space-md);
}

.plugin-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius-lg);
  background: var(--sl-surface);
  transition:
    border-color 140ms ease,
    background 140ms ease,
    transform 140ms ease;
}

.plugin-card-main {
  cursor: pointer;
}

.plugin-card:hover {
  border-color: var(--sl-primary-light);
  background: var(--sl-bg-secondary);
  transform: translateY(-1px);
}

.plugin-card-main:focus-visible {
  outline: 2px solid var(--sl-primary);
  outline-offset: -2px;
}

.plugin-card-header {
  gap: var(--sl-space-sm);
  padding: var(--sl-space-md) var(--sl-space-md) 10px;
}

.plugin-card h2 {
  min-width: 0;
  overflow: hidden;
  flex: 1;
  font-size: var(--sl-font-size-lg);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-mark {
  display: grid;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  place-items: center;
  border-radius: 12px;
  background: var(--sl-primary-bg);
  color: var(--sl-primary);
}

.plugin-card-switch {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
}

.plugin-card-badges {
  gap: 7px;
  padding: 0 var(--sl-space-md) var(--sl-space-sm);
}

.plugin-source,
.plugin-status,
.entry-state {
  display: inline-flex;
  min-height: 22px;
  align-items: center;
  padding: 2px 8px;
  border: 1px solid var(--sl-border-light);
  border-radius: var(--sl-radius-full);
  font-size: var(--sl-font-size-xs);
  font-weight: 600;
}

.plugin-source--development {
  border-color: color-mix(in srgb, var(--sl-primary) 28%, transparent);
  background: var(--sl-primary-bg);
  color: var(--sl-primary);
}

.plugin-source--installed,
.plugin-status {
  background: var(--sl-bg-secondary);
  color: var(--sl-text-secondary);
}

.plugin-status--disabled,
.entry-state--inactive {
  color: var(--sl-text-tertiary);
}

.entry-state--active {
  border-color: color-mix(in srgb, #20a464 25%, transparent);
  background: color-mix(in srgb, #20a464 9%, transparent);
  color: #168553;
}

.entry-state--failed {
  border-color: color-mix(in srgb, var(--sl-danger) 28%, transparent);
  background: color-mix(in srgb, var(--sl-danger) 8%, transparent);
  color: var(--sl-danger);
}

.plugin-card-facts,
.plugin-facts,
.entry-card dl {
  margin: 0;
}

.plugin-card-facts {
  display: grid;
  gap: 7px;
  padding: 0 var(--sl-space-md) var(--sl-space-md);
}

.plugin-card-facts > div,
.plugin-facts > div,
.entry-card dl > div {
  display: flex;
  min-width: 0;
  justify-content: space-between;
  gap: var(--sl-space-lg);
}

.plugin-card-facts dt,
.plugin-facts dt,
.entry-card dt {
  color: var(--sl-text-tertiary);
  font-size: var(--sl-font-size-sm);
}

.plugin-card-facts dd,
.plugin-facts dd,
.entry-card dd {
  min-width: 0;
  margin: 0;
  color: var(--sl-text-secondary);
  font-size: var(--sl-font-size-sm);
  text-align: right;
}

.plugin-card footer {
  justify-content: space-between;
  padding: 11px var(--sl-space-md);
  border-top: 1px solid var(--sl-border-light);
  color: var(--sl-text-secondary);
  font-size: var(--sl-font-size-sm);
}

/* 删除确认锚定页面根节点，只遮罩设置内容区域；对话框按项目约定不使用阴影。 */
.plugin-delete-layer {
  position: absolute;
  z-index: 30;
  inset: -16px -22px;
  display: grid;
  overflow: auto;
  padding: 34px 24px;
  background: color-mix(in srgb, var(--sl-bg-primary) 88%, transparent);
  place-items: start center;
}

.plugin-delete-dialog {
  width: min(100%, 560px);
  overflow: hidden;
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius-lg);
  background: var(--sl-surface);
  box-shadow: none;
}

.plugin-delete-header {
  min-height: 62px;
  justify-content: space-between;
  gap: var(--sl-space-md);
  padding: 0 20px;
  border-bottom: 1px solid var(--sl-border-light);
}

.plugin-delete-header h2 {
  margin: 0;
  color: var(--sl-text-primary);
  font-size: 1rem;
  font-weight: 650;
}

.plugin-delete-close {
  display: grid;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: var(--sl-radius-sm);
  background: transparent;
  color: var(--sl-text-secondary);
  cursor: pointer;
  place-items: center;
}

.plugin-delete-close:hover:not(:disabled) {
  background: var(--sl-bg-secondary);
  color: var(--sl-text-primary);
}

.plugin-delete-close:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.plugin-delete-body {
  padding: var(--sl-space-lg) 20px;
}

.plugin-delete-body p {
  margin: 0;
  color: var(--sl-text-secondary);
  line-height: var(--sl-line-height-relaxed);
}

.plugin-delete-body code {
  color: var(--sl-text-primary);
  font-family: var(--sl-font-mono);
  overflow-wrap: anywhere;
}

.plugin-delete-footer {
  justify-content: flex-end;
  gap: var(--sl-space-sm);
  padding: 14px 20px;
  border-top: 1px solid var(--sl-border-light);
}

.plugin-page-state {
  display: grid;
  min-height: 320px;
  place-items: center;
  align-content: center;
  gap: var(--sl-space-md);
  border: 1px dashed var(--sl-border);
  border-radius: var(--sl-radius-lg);
  color: var(--sl-text-secondary);
}

.plugin-page-state--error {
  color: var(--sl-danger);
}

.plugin-detail-toggle {
  gap: var(--sl-space-sm);
  color: var(--sl-text-secondary);
  font-size: var(--sl-font-size-sm);
}

.plugin-detail-heading {
  gap: var(--sl-space-md);
  margin-bottom: var(--sl-space-lg);
}

.plugin-detail-heading h1 {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-facts {
  overflow: hidden;
  margin-bottom: var(--sl-space-xl);
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius-lg);
  background: var(--sl-surface);
}

.plugin-facts > div {
  min-height: 52px;
  align-items: center;
  padding: 12px var(--sl-space-md);
}

.plugin-facts > div + div {
  border-top: 1px solid var(--sl-border-light);
}

.plugin-digest-row dd {
  max-width: 72%;
  overflow-wrap: anywhere;
}

.plugin-facts code,
.entry-card code {
  color: var(--sl-text-secondary);
  font-family: var(--sl-font-mono);
  font-size: var(--sl-font-size-xs);
}

.plugin-entry-section h2 {
  margin-bottom: var(--sl-space-md);
  font-size: var(--sl-font-size-lg);
  font-weight: 650;
}

.plugin-entry-list {
  display: grid;
  gap: var(--sl-space-md);
}

.entry-card {
  padding: var(--sl-space-md);
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius-lg);
  background: var(--sl-surface);
}

.entry-card header {
  justify-content: space-between;
  gap: var(--sl-space-md);
  margin-bottom: var(--sl-space-md);
}

.entry-identity {
  min-width: 0;
  gap: var(--sl-space-sm);
  color: var(--sl-text-primary);
}

.entry-identity strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry-card dl {
  display: grid;
  gap: 9px;
}

.entry-card dd {
  max-width: 70%;
  overflow-wrap: anywhere;
}

.entry-error {
  align-items: flex-start;
  gap: var(--sl-space-sm);
  margin-top: var(--sl-space-md);
  padding: 10px 12px;
  border-radius: var(--sl-radius-sm);
  background: color-mix(in srgb, var(--sl-danger) 8%, transparent);
  color: var(--sl-danger);
  font-size: var(--sl-font-size-sm);
  line-height: var(--sl-line-height-relaxed);
}

@media (max-width: 820px) {
  .plugin-grid {
    grid-template-columns: 1fr;
  }

  .plugin-detail-heading {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .plugin-digest-row,
  .entry-card dl > div {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }

  .plugin-digest-row dd,
  .entry-card dd {
    max-width: 100%;
    text-align: left;
  }
}

@media (prefers-reduced-motion: reduce) {
  .plugin-card {
    transition: none;
  }
}
</style>
