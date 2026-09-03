<script setup lang="ts">
import type { DesktopHostConnectionsSnapshot, DesktopHostConnection } from "@seashard/contracts";
import { Cmz_Button, Cmz_Modal, Cmz_Toast, useToast } from "cmzya-modern-ui";
import { useClientUiRuntime } from "@seashard/ui-runtime";
import {
  computed,
  KeepAlive,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch,
  type Component,
} from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import AppHeader from "./AppHeader.vue";
import AppSidebar from "./AppSidebar.vue";
import HostConnectionSidebar from "./HostConnectionSidebar.vue";
import logoSvg from "./assets/logo.svg";
import { PageExtensionRoot, UiEntryBoundary } from "@seashard/application-shell";
import { findHostPrompt, shouldShowHostChrome, type DesktopHostPrompt } from "./host-connections";
import {
  createWorkspaceRouteHistory,
  rememberWorkspaceRoute,
  resolveWorkspaceRoute,
  workspaceForPath,
  type SettingsMode,
  type WorkspaceMode,
} from "./workspace-layout";

const route = useRoute();
const router = useRouter();
const clientUiRuntime = useClientUiRuntime();
const toast = useToast();
const updateExitDecisionOpen = ref(false);
const updateExitAction = ref<"restart" | "close">();
let disposeUpdateExitDecision: (() => void) | undefined;
const hostConnections = shallowRef<DesktopHostConnectionsSnapshot>();
const hostAction = ref<string>();
let disposeHostConnections: (() => void) | undefined;
let latestHostRevision = -1;
const hostChromeVisible = computed(() => shouldShowHostChrome(hostConnections.value));
const hostPrompt = computed(() => findHostPrompt(hostConnections.value));
const hostPromptTitle = computed(() => {
  switch (hostPrompt.value?.kind) {
    case "missing":
      return "需要安装本机 Host";
    case "occupied":
      return "本机 Host 正在使用";
    case "outgoing":
      return "确认接管 Host";
    case "incoming":
      return "收到 Host 接管请求";
    case "unavailable":
      return "本机 Host 连接失败";
    default:
      return "Host 连接";
  }
});
const hostPromptBody = computed(() => {
  const prompt = hostPrompt.value;
  if (!prompt) return "";
  switch (prompt.kind) {
    case "missing":
      return "本机尚未安装 SeaShard Host。安装后，Controller 才能管理这台设备上的服务器实例。";
    case "occupied":
      return `${prompt.host.holder?.label ?? "另一个 Controller"} 正在控制本机 Host。你可以只读使用，或发起接管请求。`;
    case "outgoing":
      return "接管请求已创建。确认后，当前 Controller 将失去控制权，本窗口取得本机 Host 的控制权。";
    case "incoming":
      return `${prompt.host.pending?.requester.label ?? "另一个 Controller"} 请求接管本机 Host。允许后，本窗口会切换为只读。`;
    case "unavailable":
      return prompt.host.error ?? "本机 Host 当前不可用，可以重新连接或进入 Host 连接页处理。";
  }
});
const activeRuntimeId = computed(() =>
  typeof route.meta.runtimeId === "string" ? route.meta.runtimeId : undefined,
);
const activePageId = computed(() =>
  typeof route.meta.pageId === "string" ? route.meta.pageId : undefined,
);
const settingsMode = computed<SettingsMode | undefined>(() => {
  if (route.path === "/server-settings" || route.path.startsWith("/server-settings/"))
    return "server";
  if (route.path.startsWith("/settings/")) return "general";
  if (route.path === "/agent/settings" || route.path.startsWith("/agent/settings/")) return "agent";
  return undefined;
});
const downloadMode = computed(
  () => route.path === "/server/download" || route.path.startsWith("/server/download/"),
);
const workspaceRoutes = reactive(createWorkspaceRouteHistory());
const initialWorkspace =
  rememberWorkspaceRoute(workspaceRoutes, route.path, route.fullPath) ?? "agent";
const workspace = ref<WorkspaceMode>(initialWorkspace);
const rightPanelOpen = ref(false);
const appContent = ref<HTMLElement>();
const workspaceScrollTop: Record<WorkspaceMode, number> = {
  agent: 0,
  server: 0,
  launcher: 0,
};
const retainedRouteComponentNames = computed(() => {
  const names: string[] = [];
  for (const retainedWorkspace of ["agent", "server"] as const) {
    const path = router.resolve(workspaceRoutes[retainedWorkspace]).path;
    const page = clientUiRuntime.pages.value.find((candidate) => candidate.path === path);
    const name = componentName(page?.component);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
});

watch(
  () => [route.path, route.fullPath] as const,
  async ([path, fullPath], [previousPath]) => {
    const routeWorkspace = rememberWorkspaceRoute(workspaceRoutes, path, fullPath);
    const previousWorkspace = workspaceForPath(previousPath);
    const changedWorkspace = previousWorkspace !== routeWorkspace;
    if (changedWorkspace && previousWorkspace && appContent.value) {
      workspaceScrollTop[previousWorkspace] = appContent.value.scrollTop;
    }
    if (routeWorkspace) workspace.value = routeWorkspace;
    if (!changedWorkspace) return;

    await nextTick();
    // 快速连续切换时，较早的 nextTick 不得覆盖最新工作区的滚动位置。
    if (route.fullPath !== fullPath) return;
    const content = appContent.value;
    if (content) content.scrollTop = routeWorkspace ? workspaceScrollTop[routeWorkspace] : 0;
  },
);
function acceptHostSnapshot(snapshot: DesktopHostConnectionsSnapshot): void {
  if (snapshot.revision < latestHostRevision) return;
  latestHostRevision = snapshot.revision;
  hostConnections.value = snapshot;
}

onMounted(() => {
  disposeUpdateExitDecision = window.seashard.updates.onExitDecisionRequired(() => {
    updateExitDecisionOpen.value = true;
  });
  disposeHostConnections = window.seashard.hosts.onChanged(acceptHostSnapshot);
  void window.seashard.hosts
    .getSnapshot()
    .then(acceptHostSnapshot)
    .catch((error) => {
      toast.error({
        title: "读取 Host 状态失败",
        description: error instanceof Error ? error.message : String(error),
      });
    });
});

onBeforeUnmount(() => {
  disposeUpdateExitDecision?.();
  disposeHostConnections?.();
});

watch(
  [hostChromeVisible, settingsMode],
  ([visible, mode]) => {
    if (!visible || mode) rightPanelOpen.value = false;
  },
  { immediate: true },
);

function updateWorkspace(value: WorkspaceMode): void {
  const routeWorkspace = workspaceForPath(route.path);
  if (routeWorkspace === value) return;
  const target = resolveWorkspaceRoute(workspaceRoutes, value, (path) =>
    clientUiRuntime.pages.value.some((page) => page.path === path),
  );
  if (!target) return;
  void router.push(target);
}

/** KeepAlive 的 include 使用组件名，Client Entry 页面都以具名包装组件注册。 */
function componentName(component: Component | undefined): string | undefined {
  if (!component) return undefined;
  const name =
    typeof component === "function"
      ? component.name
      : (component as Readonly<{ name?: unknown }>).name;
  return typeof name === "string" && name ? name : undefined;
}
async function runHostAction(
  key: string,
  action: () => Promise<DesktopHostConnectionsSnapshot>,
): Promise<boolean> {
  if (hostAction.value) return false;
  hostAction.value = key;
  try {
    acceptHostSnapshot(await action());
    return true;
  } catch (error) {
    toast.error({
      title: "Host 操作失败",
      description: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    hostAction.value = undefined;
  }
}

function currentPendingRequest(prompt: DesktopHostPrompt): string {
  const requestId = prompt.host.pending?.requestId;
  if (!requestId) throw new Error("Host 接管请求已失效");
  return requestId;
}

async function requestHostControl(host: DesktopHostConnection): Promise<void> {
  await runHostAction("request", () => window.seashard.hosts.requestControl(host.id));
}

async function confirmHostControl(prompt: DesktopHostPrompt): Promise<void> {
  await runHostAction("confirm", () =>
    window.seashard.hosts.confirmControl(prompt.host.id, currentPendingRequest(prompt)),
  );
}

async function rejectHostControl(prompt: DesktopHostPrompt): Promise<void> {
  await runHostAction("reject", () =>
    window.seashard.hosts.rejectControl(prompt.host.id, currentPendingRequest(prompt)),
  );
}

async function acknowledgeHost(host: DesktopHostConnection): Promise<void> {
  await runHostAction("acknowledge", () => window.seashard.hosts.acknowledgeConflict(host.id));
}

async function installHost(host: DesktopHostConnection): Promise<void> {
  await runHostAction("install", () => window.seashard.hosts.install(host.id));
}

async function retryHost(host: DesktopHostConnection): Promise<void> {
  await runHostAction("retry", () => window.seashard.hosts.retry(host.id));
}

async function manageHostConnections(prompt?: DesktopHostPrompt): Promise<void> {
  if (prompt) await acknowledgeHost(prompt.host);
  rightPanelOpen.value = false;
  await router.push("/settings/hosts");
}

/**
 * 主窗口关闭已被 Main 暂停；两个选择都先走同一条安全停机链，成功后 Electron
 * 安装器才获得退出控制权。停机失败时撤掉决策层，让用户处理服务器后再次关闭。
 */
async function finishUpdateBeforeExit(afterInstall: "restart" | "close"): Promise<void> {
  if (updateExitAction.value) return;
  updateExitAction.value = afterInstall;
  try {
    const result = await window.seashard.updates.finish({
      stopRunningServers: true,
      afterInstall,
    });
    if (result?.outcome === "stop-failed") {
      updateExitDecisionOpen.value = false;
      toast.error({
        title: "停止服务器失败",
        description: result.failures
          .map((failure) => `${failure.name}：${failure.reason}`)
          .join("；"),
      });
    }
  } catch (error) {
    toast.error({
      title: "软件更新失败",
      description: error instanceof Error ? error.message : String(error),
    });
  } finally {
    updateExitAction.value = undefined;
  }
}
</script>

<template>
  <div class="app-layout" :style="{ '--sl-software-logo': `url(${logoSvg})` }">
    <div class="app-background"></div>
    <Cmz_Toast position="top-right" />
    <AppSidebar
      :workspace="workspace"
      :settings-mode="settingsMode"
      :download-mode="downloadMode"
    />
    <div class="app-main">
      <AppHeader
        :workspace="workspace"
        :settings-mode="settingsMode"
        :right-panel-open="rightPanelOpen"
        :host-connections="hostConnections"
        @update:workspace="updateWorkspace"
        @toggle-right-panel="rightPanelOpen = !rightPanelOpen"
      />
      <div class="workspace-frame">
        <main
          ref="appContent"
          class="app-content"
          :aria-label="
            settingsMode === 'general'
              ? '设置内容'
              : settingsMode === 'agent'
                ? 'Agent 设置内容'
                : settingsMode === 'server'
                  ? '服务器设置内容'
                  : downloadMode
                    ? '下载内容'
                    : '工作区内容'
          "
        >
          <RouterView v-slot="{ Component }">
            <PageExtensionRoot v-if="activePageId" :page-id="activePageId">
              <UiEntryBoundary :runtime-id="activeRuntimeId">
                <KeepAlive :include="retainedRouteComponentNames">
                  <component :is="Component" />
                </KeepAlive>
              </UiEntryBoundary>
            </PageExtensionRoot>
            <UiEntryBoundary v-else :runtime-id="activeRuntimeId">
              <component :is="Component" />
            </UiEntryBoundary>
          </RouterView>
        </main>
        <aside
          v-if="hostChromeVisible && !settingsMode && hostConnections"
          class="right-sidebar"
          :class="{ open: rightPanelOpen }"
          aria-label="Host 状态"
          :aria-hidden="!rightPanelOpen"
        >
          <HostConnectionSidebar :snapshot="hostConnections" @manage="manageHostConnections()" />
        </aside>
      </div>
    </div>
    <Cmz_Modal
      :visible="Boolean(hostPrompt)"
      :title="hostPromptTitle"
      width="460px"
      :close-on-overlay="false"
      :show-close-button="false"
    >
      <div v-if="hostPrompt" class="app-region-dialog host-control-dialog">
        {{ hostPromptBody }}
      </div>
      <template v-if="hostPrompt" #footer>
        <div class="app-region-dialog-actions">
          <template v-if="hostPrompt.kind === 'occupied'">
            <Cmz_Button
              variant="outline"
              :disabled="Boolean(hostAction)"
              @click="manageHostConnections(hostPrompt)"
            >
              管理连接
            </Cmz_Button>
            <Cmz_Button
              variant="outline"
              :loading="hostAction === 'acknowledge'"
              :disabled="Boolean(hostAction)"
              @click="acknowledgeHost(hostPrompt.host)"
            >
              只读使用
            </Cmz_Button>
            <Cmz_Button
              :loading="hostAction === 'request'"
              :disabled="Boolean(hostAction)"
              @click="requestHostControl(hostPrompt.host)"
            >
              请求接管
            </Cmz_Button>
          </template>
          <template v-else-if="hostPrompt.kind === 'outgoing'">
            <Cmz_Button
              variant="outline"
              :loading="hostAction === 'reject'"
              :disabled="Boolean(hostAction)"
              @click="rejectHostControl(hostPrompt)"
            >
              保持只读
            </Cmz_Button>
            <Cmz_Button
              :loading="hostAction === 'confirm'"
              :disabled="Boolean(hostAction)"
              @click="confirmHostControl(hostPrompt)"
            >
              确认接管
            </Cmz_Button>
          </template>
          <template v-else-if="hostPrompt.kind === 'incoming'">
            <Cmz_Button
              variant="outline"
              :loading="hostAction === 'reject'"
              :disabled="Boolean(hostAction)"
              @click="rejectHostControl(hostPrompt)"
            >
              保持控制
            </Cmz_Button>
            <Cmz_Button
              :loading="hostAction === 'confirm'"
              :disabled="Boolean(hostAction)"
              @click="confirmHostControl(hostPrompt)"
            >
              允许接管
            </Cmz_Button>
          </template>
          <template v-else-if="hostPrompt.kind === 'missing'">
            <Cmz_Button
              variant="outline"
              :loading="hostAction === 'acknowledge'"
              :disabled="Boolean(hostAction)"
              @click="acknowledgeHost(hostPrompt.host)"
            >
              稍后
            </Cmz_Button>
            <Cmz_Button
              :loading="hostAction === 'install'"
              :disabled="Boolean(hostAction)"
              @click="installHost(hostPrompt.host)"
            >
              获取 Host
            </Cmz_Button>
          </template>
          <template v-else>
            <Cmz_Button
              variant="outline"
              :disabled="Boolean(hostAction)"
              @click="manageHostConnections(hostPrompt)"
            >
              管理连接
            </Cmz_Button>
            <Cmz_Button
              variant="outline"
              :loading="hostAction === 'acknowledge'"
              :disabled="Boolean(hostAction)"
              @click="acknowledgeHost(hostPrompt.host)"
            >
              稍后
            </Cmz_Button>
            <Cmz_Button
              :loading="hostAction === 'retry'"
              :disabled="Boolean(hostAction)"
              @click="retryHost(hostPrompt.host)"
            >
              重新连接
            </Cmz_Button>
          </template>
        </div>
      </template>
    </Cmz_Modal>
    <Cmz_Modal
      :visible="updateExitDecisionOpen"
      title="安装更新"
      width="480px"
      :close-on-overlay="false"
      :show-close-button="false"
    >
      <div class="app-region-dialog app-update-exit-dialog">
        已下载的更新将在关闭前安装。请选择安装完成后的动作。
      </div>
      <template #footer>
        <div class="app-region-dialog-actions app-update-exit-actions">
          <Cmz_Button
            variant="outline"
            :loading="updateExitAction === 'restart'"
            :disabled="Boolean(updateExitAction)"
            @click="finishUpdateBeforeExit('restart')"
          >
            更新并重启
          </Cmz_Button>
          <Cmz_Button
            :loading="updateExitAction === 'close'"
            :disabled="Boolean(updateExitAction)"
            @click="finishUpdateBeforeExit('close')"
          >
            更新并关闭
          </Cmz_Button>
        </div>
      </template>
    </Cmz_Modal>
  </div>
</template>

<style scoped>
.app-update-exit-dialog {
  color: var(--sl-text-secondary);
  line-height: 1.65;
}

.host-control-dialog {
  color: var(--sl-text-secondary);
  line-height: 1.65;
}

.app-region-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sl-space-sm);
}

.app-update-exit-actions {
  display: flex;
}

/* 关闭决策属于应用级弹层，但仍只覆盖当前工作区，侧栏与标题栏保持可见。 */
:global(body:has(.app-region-dialog) .cmz-modal-overlay) {
  top: calc(var(--sl-header-height) + 8px);
  right: 12px;
  bottom: 12px;
  left: calc(var(--sl-sidebar-width) + 12px);
  overflow: hidden;
  border-radius: var(--sl-radius-lg);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

:global(body:has(.right-sidebar.open):has(.app-region-dialog) .cmz-modal-overlay) {
  right: calc(var(--sl-sidebar-width) + 20px);
}

:global(body:has(.app-region-dialog) .cmz-modal) {
  background: var(--sl-surface);
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
</style>
