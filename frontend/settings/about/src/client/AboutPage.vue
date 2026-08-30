<script setup lang="ts">
import type {
  DesktopUpdateClientService,
  DesktopUpdateFinishResult,
  DesktopUpdateRestartRequirement,
  DesktopUpdateSnapshot,
} from "@seashard/contracts";
import { Cmz_Button, Cmz_Modal, useToast } from "cmzya-modern-ui";
import { Download, ExternalLink, RefreshCw } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";

const props = defineProps<{
  updates: DesktopUpdateClientService;
}>();

const toast = useToast();
const snapshot = shallowRef<DesktopUpdateSnapshot>();
const restartRequirement = shallowRef<DesktopUpdateRestartRequirement>();
const restartWorking = ref(false);
let disposeSnapshotListener: (() => void) | undefined;

const busy = computed(
  () =>
    restartWorking.value ||
    snapshot.value?.state === "checking" ||
    snapshot.value?.state === "downloading" ||
    snapshot.value?.state === "installing",
);
const manualDownload = computed(
  () => snapshot.value?.platform === "macos" && snapshot.value.packageType === "dmg",
);
const updateStatus = computed(() => {
  const value = snapshot.value;
  if (!value) return "正在读取";
  switch (value.state) {
    case "unsupported":
      return value.reason ?? "当前安装环境不支持";
    case "idle":
      return "尚未检查";
    case "checking":
      return "正在检查";
    case "current":
      return `v${value.currentVersion} 已是最新版本`;
    case "available":
      return `v${value.latestVersion} 可用`;
    case "downloading":
      return `正在下载 ${Math.round(value.progress?.percent ?? 0)}%`;
    case "restart-required":
      return "更新已下载，等待重启";
    case "installing":
      return "正在安装并准备重启";
    case "error":
      return "等待重新检查";
  }
});
const actionLabel = computed(() => {
  switch (snapshot.value?.state) {
    case "available":
      return manualDownload.value ? "前往下载" : "一键更新";
    case "checking":
      return "检查中";
    case "downloading":
      return "下载中";
    case "restart-required":
      return "立即重启";
    case "installing":
      return "安装中";
    case "unsupported":
      return "暂不支持";
    default:
      return "检查更新";
  }
});
const progressPercent = computed(() =>
  Math.min(100, Math.max(0, snapshot.value?.progress?.percent ?? 0)),
);

onMounted(async () => {
  disposeSnapshotListener = props.updates.onSnapshotChanged((value) => {
    snapshot.value = value;
    if (value.state !== "restart-required") restartRequirement.value = undefined;
  });
  try {
    snapshot.value = await props.updates.getSnapshot();
  } catch (error) {
    toast.error({ title: "读取更新状态失败", description: errorMessage(error) });
  }
});

onBeforeUnmount(() => disposeSnapshotListener?.());

/**
 * 一个按钮遵循状态机前进：先检查并下载；安装包准备完成后由 Main 检查服务器，
 * 只有没有活动服务器，或用户明确选择安全关服时，才允许进入安装重启。
 */
async function checkOrInstall(): Promise<void> {
  const current = snapshot.value;
  if (!current || busy.value || current.state === "unsupported") return;
  if (current.state === "available") {
    try {
      handleFinishResult(await props.updates.apply());
      if (manualDownload.value) toast.info({ title: "已打开 macOS 下载页" });
    } catch (error) {
      toast.error({
        title: manualDownload.value ? "打开下载页失败" : "软件更新失败",
        description: errorMessage(error),
      });
    }
    return;
  }
  if (current.state === "restart-required") {
    await requestRestart(false);
    return;
  }

  try {
    const result = await props.updates.check();
    if (result.state === "available") {
      toast.info({
        title: "发现可用更新",
        description: `SeaShard ${result.latestVersion} 已可以下载`,
      });
    } else if (result.state === "current") {
      toast.success({ title: "已是最新版本" });
    }
  } catch (error) {
    toast.error({ title: "检查更新失败", description: errorMessage(error) });
  }
}

/** “稍后重启”只关闭强制决策层；已下载状态保留，主按钮可再次发起重启检查。 */
function deferRestart(): void {
  restartRequirement.value = undefined;
}

async function requestRestart(stopRunningServers: boolean): Promise<void> {
  if (restartWorking.value) return;
  restartWorking.value = true;
  try {
    handleFinishResult(
      await props.updates.finish({
        stopRunningServers,
        afterInstall: "restart",
      }),
    );
  } catch (error) {
    toast.error({
      title: "软件更新失败",
      description: errorMessage(error),
    });
  } finally {
    restartWorking.value = false;
  }
}

/**
 * 停机失败是可恢复的业务结果：关闭确认层、保留 restart-required，并按服务器逐项展示
 * 原因。安装器异常仍走调用异常分支，避免把安装错误误报成服务器错误。
 */
function handleFinishResult(result: DesktopUpdateFinishResult): void {
  if (result?.outcome === "running-servers") {
    restartRequirement.value = result;
    return;
  }
  restartRequirement.value = undefined;
  if (result?.outcome === "stop-failed") {
    toast.error({
      title: "停止服务器失败",
      description: result.failures
        .map((failure) => `${failure.name}：${failure.reason}`)
        .join("；"),
    });
  }
}
function runtimeStateLabel(
  state: DesktopUpdateRestartRequirement["runningServers"][number]["state"],
): string {
  if (state === "starting") return "启动中";
  if (state === "stopping") return "停止中";
  return "运行中";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <div class="about-settings-view">
    <section class="about-product" aria-labelledby="about-product-name">
      <div class="about-brand-mark" aria-hidden="true">S</div>
      <div class="about-product-copy">
        <h2 id="about-product-name">SeaShard</h2>
      </div>
      <span class="about-version">v{{ snapshot?.currentVersion ?? "—" }}</span>
    </section>

    <dl class="about-details">
      <div>
        <dt>桌面技术</dt>
        <dd>Electron + Vue 3</dd>
      </div>
      <div>
        <dt>运行时设计</dt>
        <dd>一切皆组件</dd>
      </div>
      <div class="about-update-row">
        <dt>软件更新</dt>
        <dd class="about-update-control">
          <div class="about-update-action">
            <span class="about-update-status" aria-live="polite">{{ updateStatus }}</span>
            <Cmz_Button
              variant="outline"
              size="sm"
              :loading="busy"
              :disabled="!snapshot || snapshot.state === 'unsupported' || busy"
              @click="checkOrInstall"
            >
              <ExternalLink
                v-if="snapshot?.state === 'available' && manualDownload"
                :size="15"
                :stroke-width="1.8"
              />
              <Download
                v-else-if="snapshot?.state === 'available'"
                :size="15"
                :stroke-width="1.8"
              />
              <RefreshCw v-else :size="15" :stroke-width="1.8" />
              {{ actionLabel }}
            </Cmz_Button>
          </div>
          <div
            v-if="snapshot?.state === 'downloading'"
            class="about-update-progress"
            role="progressbar"
            aria-label="软件下载进度"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="Math.round(progressPercent)"
          >
            <span :style="{ width: `${progressPercent}%` }" />
          </div>
        </dd>
      </div>
    </dl>

    <Cmz_Modal
      :visible="Boolean(restartRequirement)"
      title="更新需要重启"
      width="520px"
      :close-on-overlay="false"
      :show-close-button="false"
    >
      <div class="update-restart-content">
        <strong>以下服务器正在运行</strong>
        <ul class="update-running-server-list">
          <li v-for="server in restartRequirement?.runningServers" :key="server.instanceId">
            <span>{{ server.name }}</span>
            <small>{{ runtimeStateLabel(server.state) }}</small>
          </li>
        </ul>
      </div>
      <template #footer>
        <div class="update-restart-actions">
          <Cmz_Button variant="outline" :disabled="restartWorking" @click="deferRestart">
            稍后重启
          </Cmz_Button>
          <Cmz_Button :loading="restartWorking" @click="requestRestart(true)">
            关闭服务器并重启
          </Cmz_Button>
        </div>
      </template>
    </Cmz_Modal>
  </div>
</template>

<style scoped>
.about-settings-view {
  display: flex;
  max-width: 760px;
  margin: 0 auto;
  flex-direction: column;
  gap: var(--sl-space-lg);
  padding-bottom: var(--sl-space-2xl);
}

.about-product {
  display: flex;
  min-height: 104px;
  align-items: center;
  gap: var(--sl-space-md);
  padding: var(--sl-space-lg);
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius-lg);
  background: var(--sl-surface);
}

.about-brand-mark {
  display: grid;
  width: 52px;
  height: 52px;
  flex: 0 0 52px;
  place-items: center;
  border-radius: 14px;
  background: var(--sl-primary-bg);
  color: var(--sl-primary);
  font-size: 1.25rem;
  font-weight: 750;
}

.about-product-copy {
  min-width: 0;
  flex: 1;
}

.about-product-copy h2 {
  margin: 0;
  color: var(--sl-text-primary);
  font-size: var(--sl-font-size-xl);
  letter-spacing: -0.015em;
}

.about-version {
  flex-shrink: 0;
  padding: 5px 9px;
  border: 1px solid var(--sl-border-light);
  border-radius: var(--sl-radius-full);
  background: var(--sl-bg-secondary);
  color: var(--sl-text-secondary);
  font-family: var(--sl-font-mono);
  font-size: var(--sl-font-size-xs);
}

.about-details {
  overflow: hidden;
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius-lg);
  background: var(--sl-surface);
}

.about-details > div {
  display: flex;
  min-height: 52px;
  align-items: center;
  justify-content: space-between;
  gap: var(--sl-space-lg);
  padding: 12px var(--sl-space-md);
}

.about-details > div + div {
  border-top: 1px solid var(--sl-border-light);
}

.about-details dt {
  color: var(--sl-text-primary);
  font-size: var(--sl-font-size-base);
  font-weight: 600;
}

.about-details dd {
  color: var(--sl-text-secondary);
  font-size: var(--sl-font-size-sm);
  text-align: right;
}

.about-details > .about-update-row {
  min-height: 66px;
}

.about-update-control {
  display: flex;
  min-width: 300px;
  flex: 1;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.about-update-action {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sl-space-sm);
}

.about-update-status {
  color: var(--sl-text-secondary);
  font-size: var(--sl-font-size-sm);
}

.about-update-progress {
  width: min(320px, 100%);
  height: 5px;
  overflow: hidden;
  border-radius: var(--sl-radius-full);
  background: var(--sl-bg-secondary);
}

.about-update-progress span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--sl-primary);
  transition: width 160ms ease-out;
}

.update-restart-content {
  display: grid;
  gap: var(--sl-space-md);
  color: var(--sl-text-primary);
}

.update-restart-content strong {
  font-size: var(--sl-font-size-base);
}

.update-running-server-list {
  display: grid;
  max-height: 260px;
  overflow-y: auto;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.update-running-server-list li {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--sl-space-md);
  padding: 10px 12px;
  border: 1px solid var(--sl-border-light);
  border-radius: var(--sl-radius-md);
  background: var(--sl-bg-secondary);
}

.update-running-server-list li > span {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.update-running-server-list small {
  flex-shrink: 0;
  color: var(--sl-text-secondary);
  font-size: var(--sl-font-size-xs);
}

.update-restart-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sl-space-sm);
}

/* 更新决策层保留遮罩，但只覆盖工作区内容；标题栏、导航栏继续保持可见。 */
:global(body:has(.about-settings-view) .cmz-modal-overlay) {
  top: calc(var(--sl-header-height) + 8px);
  right: 12px;
  bottom: 12px;
  left: calc(var(--sl-sidebar-width) + 12px);
  overflow: hidden;
  border-radius: var(--sl-radius-lg);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

:global(body:has(.about-settings-view) .cmz-modal) {
  background: var(--sl-surface);
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

@media (max-width: 680px) {
  .about-details > div {
    align-items: flex-start;
  }

  .about-update-control {
    min-width: 0;
  }

  .about-update-action {
    flex-wrap: wrap;
  }
}
</style>
