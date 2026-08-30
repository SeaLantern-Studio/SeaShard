<script setup lang="ts">
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
  watch,
  type Component,
} from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import AppHeader from "./AppHeader.vue";
import AppSidebar from "./AppSidebar.vue";
import logoSvg from "./assets/logo.svg";
import PageExtensionRoot from "./PageExtensionRoot.vue";
import UiEntryBoundary from "./UiEntryBoundary.vue";
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
const activeRuntimeId = computed(() =>
  typeof route.meta.runtimeId === "string" ? route.meta.runtimeId : undefined,
);
const activePageId = computed(() =>
  typeof route.meta.pageId === "string" ? route.meta.pageId : undefined,
);
const settingsMode = computed<SettingsMode | undefined>(() => {
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
onMounted(() => {
  disposeUpdateExitDecision = window.seashard.updates.onExitDecisionRequired(() => {
    updateExitDecisionOpen.value = true;
  });
});

onBeforeUnmount(() => disposeUpdateExitDecision?.());

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
          class="right-sidebar"
          :class="{ open: rightPanelOpen && !settingsMode }"
          aria-label="右侧栏"
          :aria-hidden="!!settingsMode || !rightPanelOpen"
        ></aside>
      </div>
    </div>
    <Cmz_Modal
      :visible="updateExitDecisionOpen"
      title="安装更新"
      width="480px"
      :close-on-overlay="false"
      :show-close-button="false"
    >
      <div class="app-update-exit-dialog">已下载的更新将在关闭前安装。请选择安装完成后的动作。</div>
      <template #footer>
        <div class="app-update-exit-actions">
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

.app-update-exit-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sl-space-sm);
}

/* 关闭决策属于应用级弹层，但仍只覆盖当前工作区，侧栏与标题栏保持可见。 */
:global(body:has(.app-update-exit-dialog) .cmz-modal-overlay) {
  top: calc(var(--sl-header-height) + 8px);
  right: 12px;
  bottom: 12px;
  left: calc(var(--sl-sidebar-width) + 12px);
  overflow: hidden;
  border-radius: var(--sl-radius-lg);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

:global(body:has(.right-sidebar.open):has(.app-update-exit-dialog) .cmz-modal-overlay) {
  right: calc(var(--sl-sidebar-width) + 20px);
}

:global(body:has(.app-update-exit-dialog) .cmz-modal) {
  background: var(--sl-surface);
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
</style>
