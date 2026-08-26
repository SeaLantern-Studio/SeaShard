<script setup lang="ts">
import type {
  PluginMarketInstallationSnapshot,
  PluginMarketInstallService,
  PluginMarketPlugin,
  PluginMarketRelease,
  PluginMarketSearchResult,
  PluginMarketService,
} from "@seashard/contracts";
import { Cmz_Button, Cmz_Spinner, Cmz_Toast, useToast } from "cmzya-modern-ui";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Github,
  Package,
  RefreshCw,
  Search,
  ShoppingBag,
  TriangleAlert,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{
  market: PluginMarketService;
  installer: PluginMarketInstallService;
}>();

const pageSize = 20;
const toast = useToast();
const result = ref<PluginMarketSearchResult>();
const queryInput = ref("");
const query = ref("");
const page = ref(1);
const loading = ref(true);
const refreshing = ref(false);
const loadFailed = ref(false);
const selectedPlugin = ref<PluginMarketPlugin>();
const installations = ref<readonly PluginMarketInstallationSnapshot[]>([]);
const installingKeys = ref<ReadonlySet<string>>(new Set());
let disposed = false;
let requestSequence = 0;

const plugins = computed(() => result.value?.plugins ?? []);
const hasPreviousPage = computed(() => page.value > 1);
const hasNextPage = computed(() => {
  const snapshot = result.value;
  return snapshot ? page.value * snapshot.pageSize < snapshot.totalCount : false;
});

onMounted(() => void loadPlugins(true));

onBeforeUnmount(() => {
  disposed = true;
  requestSequence += 1;
});

/** 搜索与翻页共享单一序列，保证慢响应不会覆盖用户最后一次操作。 */
async function loadPlugins(reportFailure: boolean, forceRefresh = false): Promise<void> {
  const sequence = ++requestSequence;
  if (!result.value) loading.value = true;
  if (forceRefresh) refreshing.value = true;
  try {
    const [snapshot, installed] = await Promise.all([
      props.market.search({
        query: query.value,
        page: page.value,
        pageSize,
        ...(forceRefresh ? { refresh: true } : {}),
      }),
      props.installer.list(),
    ]);
    if (disposed || sequence !== requestSequence) return;
    result.value = snapshot;
    installations.value = installed;
    loadFailed.value = false;
  } catch (error) {
    if (disposed || sequence !== requestSequence) return;
    loadFailed.value = !result.value;
    if (reportFailure) {
      toast.error({ title: "读取插件市场失败", description: errorMessage(error) });
    }
  } finally {
    if (!disposed && sequence === requestSequence) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

function submitSearch(): void {
  query.value = queryInput.value.trim();
  page.value = 1;
  void loadPlugins(true);
}

function changePage(nextPage: number): void {
  if (nextPage < 1 || nextPage === page.value) return;
  page.value = nextPage;
  void loadPlugins(true);
}

function refresh(): void {
  void loadPlugins(true, true);
}

function openDetails(plugin: PluginMarketPlugin): void {
  selectedPlugin.value = plugin;
}

function closeDetails(): void {
  selectedPlugin.value = undefined;
}

function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Registry 已按语义版本倒序生成，首个未撤回版本就是当前推荐展示版本。 */
function currentRelease(plugin: PluginMarketPlugin): PluginMarketRelease | undefined {
  return plugin.releases.find((release) => !release.yanked);
}

function installedPlugin(pluginId: string): PluginMarketInstallationSnapshot | undefined {
  return installations.value.find((installation) => installation.id === pluginId);
}

function installationKey(pluginId: string, version: string): string {
  return `${pluginId}@${version}`;
}

function isInstalling(pluginId: string, version: string): boolean {
  return installingKeys.value.has(installationKey(pluginId, version));
}

function installActionLabel(plugin: PluginMarketPlugin, release: PluginMarketRelease): string {
  const installed = installedPlugin(plugin.id);
  if (installed?.source === "development") return "开发版本";
  if (installed?.digest === release.packageDigest) return "已安装";
  return installed ? "更新" : "安装";
}

function canInstall(plugin: PluginMarketPlugin, release: PluginMarketRelease): boolean {
  const installed = installedPlugin(plugin.id);
  return (
    !release.yanked &&
    installed?.source !== "development" &&
    installed?.digest !== release.packageDigest &&
    !isInstalling(plugin.id, release.version)
  );
}

function currentInstallActionLabel(plugin: PluginMarketPlugin): string {
  const release = currentRelease(plugin);
  return release ? installActionLabel(plugin, release) : "不可安装";
}

function canInstallCurrent(plugin: PluginMarketPlugin): boolean {
  const release = currentRelease(plugin);
  return release ? canInstall(plugin, release) : false;
}

function isInstallingCurrent(plugin: PluginMarketPlugin): boolean {
  const release = currentRelease(plugin);
  return release ? isInstalling(plugin.id, release.version) : false;
}

function installCurrent(plugin: PluginMarketPlugin): void {
  const release = currentRelease(plugin);
  if (release) void installRelease(plugin, release);
}

/** 安装按钮本身就是完整信任确认；Host 仍会独立校验 Registry 地址与两层摘要。 */
async function installRelease(
  plugin: PluginMarketPlugin,
  release: PluginMarketRelease,
): Promise<void> {
  if (!canInstall(plugin, release)) return;
  const key = installationKey(plugin.id, release.version);
  const wasInstalled = Boolean(installedPlugin(plugin.id));
  installingKeys.value = new Set(installingKeys.value).add(key);
  try {
    const installed = await props.installer.install({
      pluginId: plugin.id,
      version: release.version,
      acknowledgeFullMachineAccess: true,
    });
    installations.value = [
      ...installations.value.filter(({ id }) => id !== installed.id),
      installed,
    ].sort((left, right) => left.id.localeCompare(right.id));
    toast.success({
      title: wasInstalled ? "插件已更新" : "插件已安装",
      description: `${plugin.name} ${release.version} 已安装并启用`,
    });
  } catch (error) {
    toast.error({
      title: wasInstalled ? "更新插件失败" : "安装插件失败",
      description: errorMessage(error),
    });
  } finally {
    const next = new Set(installingKeys.value);
    next.delete(key);
    installingKeys.value = next;
  }
}

function runtimeSummary(release: PluginMarketRelease | undefined): string {
  if (!release) return "无可用版本";
  const runtimes = [...new Set(release.entries.map((entry) => entry.runtime))];
  return runtimes.map((runtime) => (runtime === "host" ? "Host" : "Client")).join("、");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const selectedCurrentRelease = computed(() =>
  selectedPlugin.value ? currentRelease(selectedPlugin.value) : undefined,
);
</script>

<template>
  <section class="plugin-market-page" aria-label="插件市场">
    <Cmz_Toast position="top-right" />

    <template v-if="selectedPlugin">
      <header class="market-detail-toolbar">
        <Cmz_Button variant="outline" size="sm" @click="closeDetails">
          <ArrowLeft :size="16" :stroke-width="1.8" />
          返回
        </Cmz_Button>
        <div class="detail-actions">
          <Cmz_Button variant="outline" size="sm" @click="openExternal(selectedPlugin.source.url)">
            <Github :size="16" :stroke-width="1.8" />
            源码
            <ExternalLink :size="14" :stroke-width="1.8" />
          </Cmz_Button>
          <Cmz_Button
            v-if="selectedCurrentRelease"
            variant="outline"
            size="sm"
            @click="openExternal(selectedCurrentRelease.releaseUrl)"
          >
            Release
            <ExternalLink :size="14" :stroke-width="1.8" />
          </Cmz_Button>
        </div>
      </header>

      <div class="market-detail-heading">
        <span class="plugin-mark" aria-hidden="true">
          <Package :size="24" :stroke-width="1.8" />
        </span>
        <h1>{{ selectedPlugin.name }}</h1>
        <span class="registry-badge">官方目录</span>
        <span v-if="installedPlugin(selectedPlugin.id)" class="installed-badge">
          {{
            installedPlugin(selectedPlugin.id)?.source === "development"
              ? `开发版本 ${installedPlugin(selectedPlugin.id)?.version}`
              : `已安装 ${installedPlugin(selectedPlugin.id)?.version}`
          }}
        </span>
      </div>

      <dl class="plugin-facts">
        <div>
          <dt>插件 ID</dt>
          <dd>
            <code>{{ selectedPlugin.id }}</code>
          </dd>
        </div>
        <div>
          <dt>简介</dt>
          <dd>{{ selectedPlugin.summary }}</dd>
        </div>
        <div>
          <dt>维护者</dt>
          <dd>{{ selectedPlugin.owners.join("、") }}</dd>
        </div>
        <div>
          <dt>源码仓库</dt>
          <dd>
            <code>{{ selectedPlugin.source.repository }}</code>
          </dd>
        </div>
        <div>
          <dt>许可证</dt>
          <dd>
            <code>{{ selectedPlugin.license }}</code>
          </dd>
        </div>
        <div>
          <dt>权限模型</dt>
          <dd>第三方包完整信任</dd>
        </div>
      </dl>

      <section class="release-section" aria-labelledby="release-section-title">
        <div class="release-section-heading">
          <h2 id="release-section-title">发布版本</h2>
        </div>

        <div class="release-list">
          <article
            v-for="release in selectedPlugin.releases"
            :key="`${selectedPlugin.id}@${release.version}`"
            class="release-card"
          >
            <header class="release-card-heading">
              <h3>{{ release.version }}</h3>
              <div class="release-card-actions">
                <span v-if="release.yanked" class="yanked-badge">已撤回</span>
                <span
                  v-else-if="installedPlugin(selectedPlugin.id)?.digest === release.packageDigest"
                  class="installed-badge"
                >
                  已安装
                </span>
                <span v-else class="version-badge">可用</span>
                <Cmz_Button
                  v-if="!release.yanked"
                  size="sm"
                  :loading="isInstalling(selectedPlugin.id, release.version)"
                  :disabled="!canInstall(selectedPlugin, release)"
                  @click="installRelease(selectedPlugin, release)"
                >
                  <Download
                    v-if="canInstall(selectedPlugin, release)"
                    :size="15"
                    :stroke-width="1.8"
                  />
                  {{ installActionLabel(selectedPlugin, release) }}
                </Cmz_Button>
              </div>
            </header>
            <dl class="release-facts">
              <div>
                <dt>发布者</dt>
                <dd>
                  <code>{{ release.publisher }}</code>
                </dd>
              </div>
              <div>
                <dt>SeaShard 兼容范围</dt>
                <dd>
                  <code>{{ release.compatibility.seaShard }}</code>
                </dd>
              </div>
              <div v-if="release.compatibility.clientProtocol">
                <dt>Client Protocol</dt>
                <dd>
                  <code>{{ release.compatibility.clientProtocol }}</code>
                </dd>
              </div>
              <div>
                <dt>入口</dt>
                <dd>{{ release.entries.length }} 个 · {{ runtimeSummary(release) }}</dd>
              </div>
              <div>
                <dt>包内容</dt>
                <dd>{{ release.fileCount }} 个文件 · {{ formatSize(release.unpackedSize) }}</dd>
              </div>
              <div>
                <dt>归档 SHA-256</dt>
                <dd>
                  <code>{{ release.archiveSha256 }}</code>
                </dd>
              </div>
              <div>
                <dt>Package Digest</dt>
                <dd>
                  <code>{{ release.packageDigest }}</code>
                </dd>
              </div>
            </dl>
          </article>
        </div>
      </section>
    </template>

    <template v-else>
      <header class="market-list-heading">
        <h1>插件市场</h1>
        <Cmz_Button
          variant="outline"
          size="sm"
          :disabled="refreshing"
          aria-label="刷新插件市场"
          @click="refresh"
        >
          <RefreshCw :size="16" :stroke-width="1.8" />
          刷新
        </Cmz_Button>
      </header>

      <form class="market-search" role="search" @submit.prevent="submitSearch">
        <Search :size="18" :stroke-width="1.8" aria-hidden="true" />
        <input
          v-model="queryInput"
          type="search"
          maxlength="100"
          autocomplete="off"
          aria-label="搜索插件"
          placeholder="搜索名称、ID、维护者或简介"
        />
        <Cmz_Button type="submit" variant="outline" size="sm">搜索</Cmz_Button>
      </form>

      <div v-if="loading" class="market-page-state">
        <Cmz_Spinner size="lg" />
      </div>

      <div v-else-if="loadFailed" class="market-page-state market-page-state--error">
        <TriangleAlert :size="26" :stroke-width="1.8" />
        <strong>插件市场读取失败</strong>
        <Cmz_Button variant="outline" size="sm" @click="loadPlugins(true, true)">重试</Cmz_Button>
      </div>

      <div v-else-if="plugins.length === 0" class="market-page-state">
        <ShoppingBag :size="30" :stroke-width="1.7" />
        <strong>没有找到插件</strong>
      </div>

      <template v-else>
        <div class="market-grid">
          <article v-for="plugin in plugins" :key="plugin.id" class="market-card">
            <div
              class="market-card-main"
              role="button"
              tabindex="0"
              :aria-label="`查看 ${plugin.name} 详情`"
              @click="openDetails(plugin)"
              @keydown.enter="openDetails(plugin)"
              @keydown.space.prevent="openDetails(plugin)"
            >
              <header>
                <span class="plugin-mark" aria-hidden="true">
                  <Package :size="22" :stroke-width="1.8" />
                </span>
                <h2>{{ plugin.name }}</h2>
              </header>

              <div class="market-card-badges">
                <span class="registry-badge">官方目录</span>
                <span v-if="currentRelease(plugin)" class="version-badge">
                  {{ currentRelease(plugin)?.version }}
                </span>
                <span v-else class="yanked-badge">全部撤回</span>
                <span v-if="installedPlugin(plugin.id)" class="installed-badge">
                  {{
                    installedPlugin(plugin.id)?.source === "development"
                      ? `开发版本 ${installedPlugin(plugin.id)?.version}`
                      : `已安装 ${installedPlugin(plugin.id)?.version}`
                  }}
                </span>
              </div>

              <dl>
                <div>
                  <dt>插件 ID</dt>
                  <dd>
                    <code>{{ plugin.id }}</code>
                  </dd>
                </div>
                <div>
                  <dt>发布者</dt>
                  <dd>{{ currentRelease(plugin)?.publisher || "无可用版本" }}</dd>
                </div>
                <div>
                  <dt>Runtime</dt>
                  <dd>{{ runtimeSummary(currentRelease(plugin)) }}</dd>
                </div>
                <div>
                  <dt>许可证</dt>
                  <dd>{{ plugin.license }}</dd>
                </div>
              </dl>
            </div>

            <footer>
              <Cmz_Button variant="ghost" size="sm" @click="openDetails(plugin)">
                插件详情
                <ChevronRight :size="17" :stroke-width="1.8" />
              </Cmz_Button>
              <Cmz_Button
                v-if="currentRelease(plugin)"
                size="sm"
                :loading="isInstallingCurrent(plugin)"
                :disabled="!canInstallCurrent(plugin)"
                @click="installCurrent(plugin)"
              >
                <Download v-if="canInstallCurrent(plugin)" :size="15" :stroke-width="1.8" />
                {{ currentInstallActionLabel(plugin) }}
              </Cmz_Button>
            </footer>
          </article>
        </div>

        <footer class="market-pagination">
          <Cmz_Button
            variant="outline"
            size="sm"
            :disabled="!hasPreviousPage"
            @click="changePage(page - 1)"
          >
            <ChevronLeft :size="16" :stroke-width="1.8" />
            上一页
          </Cmz_Button>
          <span>第 {{ page }} 页 · 共 {{ result?.totalCount ?? 0 }} 个插件</span>
          <Cmz_Button
            variant="outline"
            size="sm"
            :disabled="!hasNextPage"
            @click="changePage(page + 1)"
          >
            下一页
            <ChevronRight :size="16" :stroke-width="1.8" />
          </Cmz_Button>
        </footer>
      </template>
    </template>
  </section>
</template>

<style scoped>
.plugin-market-page {
  width: min(100%, 980px);
  min-height: 100%;
  margin: 0 auto;
  padding-bottom: var(--sl-space-2xl);
}

.market-list-heading,
.market-detail-toolbar,
.market-detail-heading,
.detail-actions,
.market-card header,
.market-card footer,
.market-card-badges,
.market-search,
.market-pagination,
.release-section-heading,
.release-card-heading,
.release-card-actions {
  display: flex;
  align-items: center;
}

.market-list-heading,
.market-detail-toolbar {
  min-height: 48px;
  justify-content: space-between;
  gap: var(--sl-space-md);
  margin-bottom: var(--sl-space-lg);
}

.detail-actions {
  gap: var(--sl-space-sm);
}

.market-list-heading h1,
.market-detail-heading h1,
.release-section-heading h2,
.market-card h2,
.release-card h3 {
  margin: 0;
  color: var(--sl-text-primary);
}

.market-list-heading h1,
.market-detail-heading h1 {
  font-size: 1.75rem;
  font-weight: 680;
  letter-spacing: -0.04em;
}

.market-search {
  height: 44px;
  gap: var(--sl-space-sm);
  margin-bottom: var(--sl-space-lg);
  padding: 0 8px 0 13px;
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius-md);
  background: var(--sl-surface);
  color: var(--sl-text-tertiary);
}

.market-search:focus-within {
  border-color: var(--sl-primary);
}

.market-search input {
  min-width: 0;
  height: 100%;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--sl-text-primary);
  font: inherit;
}

.market-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sl-space-md);
}

.market-card,
.release-card,
.plugin-facts {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius-lg);
  background: var(--sl-surface);
}

.market-card {
  transition:
    border-color 140ms ease,
    background 140ms ease,
    transform 140ms ease;
}

.market-card-main {
  cursor: pointer;
}

.market-card:hover {
  border-color: var(--sl-primary-light);
  background: var(--sl-bg-secondary);
  transform: translateY(-1px);
}

.market-card-main:focus-visible {
  outline: 2px solid var(--sl-primary);
  outline-offset: -2px;
}

.market-card header {
  gap: var(--sl-space-sm);
  padding: var(--sl-space-md) var(--sl-space-md) 10px;
}

.market-card h2 {
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

.market-card-badges {
  gap: 7px;
  flex-wrap: wrap;
  padding: 0 var(--sl-space-md) var(--sl-space-sm);
}

.registry-badge,
.version-badge,
.installed-badge,
.yanked-badge {
  display: inline-flex;
  min-height: 22px;
  align-items: center;
  padding: 2px 8px;
  border: 1px solid var(--sl-border-light);
  border-radius: var(--sl-radius-full);
  font-size: var(--sl-font-size-xs);
  font-weight: 600;
}

.registry-badge,
.version-badge {
  border-color: color-mix(in srgb, var(--sl-primary) 28%, transparent);
  background: var(--sl-primary-bg);
  color: var(--sl-primary);
}

.installed-badge {
  border-color: color-mix(in srgb, var(--sl-success) 30%, transparent);
  background: var(--sl-success-bg);
  color: var(--sl-success);
}

.yanked-badge {
  border-color: color-mix(in srgb, var(--sl-danger) 28%, transparent);
  background: color-mix(in srgb, var(--sl-danger) 8%, transparent);
  color: var(--sl-danger);
}

.market-card dl,
.plugin-facts,
.release-facts {
  margin: 0;
}

.market-card dl {
  display: grid;
  gap: 7px;
  padding: 0 var(--sl-space-md) var(--sl-space-md);
}

.market-card dl > div,
.plugin-facts > div,
.release-facts > div {
  display: flex;
  min-width: 0;
  justify-content: space-between;
  gap: var(--sl-space-lg);
}

.market-card dt,
.plugin-facts dt,
.release-facts dt {
  color: var(--sl-text-tertiary);
  font-size: var(--sl-font-size-sm);
}

.market-card dd,
.plugin-facts dd,
.release-facts dd {
  min-width: 0;
  margin: 0;
  color: var(--sl-text-secondary);
  font-size: var(--sl-font-size-sm);
  overflow-wrap: anywhere;
  text-align: right;
}

.market-card footer {
  justify-content: space-between;
  padding: 11px var(--sl-space-md);
  border-top: 1px solid var(--sl-border-light);
  color: var(--sl-text-secondary);
  font-size: var(--sl-font-size-sm);
}

.release-card-actions {
  justify-content: flex-end;
  gap: var(--sl-space-sm);
  flex-wrap: wrap;
}

.market-pagination {
  justify-content: space-between;
  gap: var(--sl-space-md);
  margin-top: var(--sl-space-lg);
  color: var(--sl-text-tertiary);
  font-size: var(--sl-font-size-sm);
}

.market-page-state {
  display: grid;
  min-height: 280px;
  place-items: center;
  align-content: center;
  gap: var(--sl-space-md);
  border: 1px dashed var(--sl-border);
  border-radius: var(--sl-radius-lg);
  color: var(--sl-text-secondary);
}

.market-page-state--error {
  color: var(--sl-danger);
}

.market-detail-heading {
  gap: var(--sl-space-md);
  margin-bottom: var(--sl-space-lg);
}

.market-detail-heading h1 {
  min-width: 0;
  overflow-wrap: anywhere;
}

.plugin-facts {
  margin-bottom: var(--sl-space-xl);
}

.plugin-facts > div,
.release-facts > div {
  padding: 12px var(--sl-space-md);
}

.plugin-facts > div + div,
.release-facts > div + div {
  border-top: 1px solid var(--sl-border-light);
}

.plugin-facts dd,
.release-facts dd {
  max-width: 70%;
}

.release-section-heading {
  min-height: 40px;
  justify-content: space-between;
  gap: var(--sl-space-md);
  margin-bottom: var(--sl-space-md);
}

.release-section-heading h2 {
  font-size: var(--sl-font-size-xl);
  font-weight: 670;
}

.release-list {
  display: grid;
  gap: var(--sl-space-md);
}

.release-card-heading {
  justify-content: space-between;
  gap: var(--sl-space-md);
  padding: 13px var(--sl-space-md);
  border-bottom: 1px solid var(--sl-border-light);
}

.release-card h3 {
  font-size: var(--sl-font-size-lg);
  font-weight: 650;
}

code {
  font-family: var(--sl-font-mono);
}

@media (max-width: 760px) {
  .market-grid {
    grid-template-columns: 1fr;
  }

  .market-detail-heading,
  .market-detail-toolbar {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .market-detail-heading h1 {
    width: calc(100% - 58px);
  }

  .detail-actions {
    flex-wrap: wrap;
  }

  .plugin-facts > div,
  .release-facts > div {
    align-items: flex-start;
    flex-direction: column;
    gap: 5px;
  }

  .plugin-facts dd,
  .release-facts dd {
    max-width: none;
    text-align: left;
  }

  .market-pagination {
    flex-wrap: wrap;
  }
}
</style>
