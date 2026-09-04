<script setup lang="ts">
import {
  ApplicationHeader,
  ApplicationSidebar,
  PageExtensionRoot,
  UiEntryBoundary,
  createWorkspaceRouteHistory,
  rememberWorkspaceRoute,
  resolveWorkspaceRoute,
  workspaceForPath,
  type SettingsMode,
  type WorkspaceMode,
} from "@seashard/application-shell";
import { ServerWebAuthenticationPage } from "@seashard/server-web-auth-ui/client";
import type { ServerWebBootstrapSnapshot } from "@seashard/server-web-api";
import { useClientUiRuntime } from "@seashard/ui-runtime";
import { Cmz_Toast, useToast } from "cmzya-modern-ui";
import { LogOut } from "lucide-vue-next";
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
import { acceptServerControllerVersion } from "./about";
import {
  hydrateServerAppearance,
  onServerAppearancePersistenceError,
  serverAppearanceService,
} from "./appearance";
import { RouterView, useRoute, useRouter } from "vue-router";
import {
  authenticateServerWeb,
  loadServerClientBootstrap,
  loadServerWebAuthentication,
  logoutServerWeb,
  onServerWebAuthenticationRequired,
  serverWebEvents,
  type ServerWebCredentials,
} from "./client-runtime";

type AuthenticationState = "loading" | "guest" | "authenticated";

const runtime = useClientUiRuntime();
const route = useRoute();
const router = useRouter();
const toast = useToast();
const authenticationState = ref<AuthenticationState>("loading");
const setupRequired = ref(false);
const authenticationBusy = ref(false);
const appContent = ref<HTMLElement>();
let disposeAuthenticationRequired: (() => void) | undefined;
let disposeAppearancePersistenceError: (() => void) | undefined;
let disposeClientBootstrap: (() => void) | undefined;

const activeRuntimeId = computed(() =>
  typeof route.meta.runtimeId === "string" ? route.meta.runtimeId : undefined,
);
const activePageId = computed(() =>
  typeof route.meta.pageId === "string" ? route.meta.pageId : undefined,
);
const workspaceRoutes = reactive(createWorkspaceRouteHistory());
const initialWorkspace =
  rememberWorkspaceRoute(workspaceRoutes, route.path, route.fullPath) ?? "agent";
const workspace = ref<WorkspaceMode>(initialWorkspace);
const workspaceScrollTop: Record<WorkspaceMode, number> = {
  agent: 0,
  server: 0,
  launcher: 0,
};
const settingsMode = computed<SettingsMode | undefined>(() => {
  if (route.path === "/server-settings" || route.path.startsWith("/server-settings/")) {
    return "server";
  }
  if (route.path.startsWith("/settings/")) return "general";
  if (route.path === "/agent/settings" || route.path.startsWith("/agent/settings/")) {
    return "agent";
  }
  return undefined;
});
const downloadMode = computed(
  () => route.path === "/server/download" || route.path.startsWith("/server/download/"),
);
const retainedRouteComponentNames = computed(() => {
  const names: string[] = [];
  for (const retainedWorkspace of ["agent", "server"] as const) {
    const path = router.resolve(workspaceRoutes[retainedWorkspace]).path;
    const page = runtime.pages.value.find((candidate) => candidate.path === path);
    const name = componentName(page?.component);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
});

onMounted(() => {
  disposeAppearancePersistenceError = onServerAppearancePersistenceError((error) => {
    notifyError("保存外观设置失败", error);
  });
  disposeAuthenticationRequired = onServerWebAuthenticationRequired(() => {
    if (authenticationState.value === "authenticated") {
      toast.info({ title: "登录已过期" });
    }
    void showAuthentication(false);
  });
  void restoreAuthentication();
});

onBeforeUnmount(() => {
  disposeAuthenticationRequired?.();
  disposeAppearancePersistenceError?.();
  disposeClientBootstrap?.();
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
    if (path === "/" && authenticationState.value === "authenticated") {
      await navigateToApplicationLanding();
      return;
    }
    if (!changedWorkspace) return;

    await nextTick();
    // 快速连续切换时，较早的 nextTick 不得覆盖最新工作区的滚动位置。
    if (route.fullPath !== fullPath) return;
    const content = appContent.value;
    if (content) content.scrollTop = routeWorkspace ? workspaceScrollTop[routeWorkspace] : 0;
  },
);

/** 登录成功后才装载 Client Entry，未鉴权浏览器接触不到页面清单与调用身份。 */
async function enterApplication(snapshot: ServerWebBootstrapSnapshot): Promise<void> {
  acceptServerControllerVersion(snapshot.controllerVersion);
  try {
    await hydrateServerAppearance();
  } catch (error) {
    notifyError("读取外观设置失败", error);
  }
  await runtime.reconcile(await loadServerClientBootstrap());
  disposeClientBootstrap?.();
  disposeClientBootstrap = serverWebEvents.subscribeClientBootstrap((bootstrap) => {
    void runtime.reconcile(bootstrap).catch((error) => runtime.failBootstrap(error));
  });
  setupRequired.value = snapshot.setupRequired;
  authenticationState.value = "authenticated";

  const currentPath = route.path;
  const currentPage = runtime.pages.value.find(({ path }) => path === currentPath);
  if (!currentPage) await navigateToApplicationLanding();
}

async function navigateToApplicationLanding(): Promise<void> {
  const target = resolveWorkspaceRoute(workspaceRoutes, workspace.value, (path) =>
    runtime.pages.value.some((page) => page.path === path),
  );
  if (target) await router.replace(target);
}

function updateWorkspace(value: WorkspaceMode): void {
  const routeWorkspace = workspaceForPath(route.path);
  if (routeWorkspace === value) return;
  const target = resolveWorkspaceRoute(workspaceRoutes, value, (path) =>
    runtime.pages.value.some((page) => page.path === path),
  );
  if (target) void router.push(target);
}

async function restoreAuthentication(): Promise<void> {
  try {
    const snapshot = await loadServerWebAuthentication();
    setupRequired.value = snapshot.setupRequired;
    if (snapshot.authenticated) {
      await enterApplication(snapshot);
    } else {
      authenticationState.value = "guest";
    }
  } catch (error) {
    authenticationState.value = "guest";
    notifyError("读取登录状态失败", error);
  }
}

async function authenticate(credentials: ServerWebCredentials): Promise<void> {
  if (authenticationBusy.value) return;
  authenticationBusy.value = true;
  try {
    const snapshot = await authenticateServerWeb(credentials, setupRequired.value);
    await enterApplication(snapshot);
  } catch (error) {
    notifyError(setupRequired.value ? "管理员设置失败" : "登录失败", error);
  } finally {
    authenticationBusy.value = false;
  }
}

async function logout(): Promise<void> {
  if (authenticationBusy.value) return;
  authenticationBusy.value = true;
  try {
    await logoutServerWeb();
    await showAuthentication(false);
  } catch (error) {
    notifyError("退出登录失败", error);
  } finally {
    authenticationBusy.value = false;
  }
}

async function showAuthentication(nextSetupRequired: boolean): Promise<void> {
  setupRequired.value = nextSetupRequired;
  authenticationState.value = "guest";
  disposeClientBootstrap?.();
  disposeClientBootstrap = undefined;
  await router.replace("/");
  await runtime.dispose();
}

/** KeepAlive 的 include 使用 Client Entry 包装组件名，与 Desktop 保持同一保留规则。 */
function componentName(component: Component | undefined): string | undefined {
  if (!component) return undefined;
  const name =
    typeof component === "function"
      ? component.name
      : (component as Readonly<{ name?: unknown }>).name;
  return typeof name === "string" && name ? name : undefined;
}

function notifyError(title: string, error: unknown): void {
  toast.error({ title, description: error instanceof Error ? error.message : String(error) });
}
</script>

<template>
  <Cmz_Toast position="top-right" />
  <ServerWebAuthenticationPage
    v-if="authenticationState !== 'authenticated'"
    :setup-required="setupRequired"
    :busy="authenticationBusy || authenticationState === 'loading'"
    @submit="authenticate"
  />
  <div v-else class="app-layout" data-server-web-shell>
    <div class="app-background"></div>
    <ApplicationSidebar
      :workspace="workspace"
      :settings-mode="settingsMode"
      :download-mode="downloadMode"
    />
    <div class="app-main">
      <ApplicationHeader
        :workspace="workspace"
        :workspaces="['agent', 'server']"
        :settings-mode="settingsMode"
        :theme="serverAppearanceService.settings.value.theme"
        @update:theme="serverAppearanceService.update({ theme: $event })"
        @update:workspace="updateWorkspace"
      >
        <template #actions>
          <button
            type="button"
            class="language-button server-web-logout"
            title="退出登录"
            aria-label="退出登录"
            :disabled="authenticationBusy"
            @click="logout"
          >
            <LogOut :size="16" />
          </button>
        </template>
      </ApplicationHeader>
      <div class="workspace-frame">
        <main ref="appContent" class="app-content" aria-label="工作区内容">
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
      </div>
    </div>
  </div>
</template>
