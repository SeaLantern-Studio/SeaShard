<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import AppHeader from "./AppHeader.vue";
import AppSidebar from "./AppSidebar.vue";
import logoSvg from "./assets/logo.svg";
import UiEntryBoundary from "./UiEntryBoundary.vue";
import type { WorkspaceMode } from "./workspace-layout";

const route = useRoute();
const router = useRouter();
const activeRuntimeId = computed(() =>
  typeof route.meta.runtimeId === "string" ? route.meta.runtimeId : undefined,
);
const settingsMode = computed(() => route.path.startsWith("/settings/"));
const downloadMode = computed(() => route.path.startsWith("/server/download"));
const workspace = ref<WorkspaceMode>(workspaceForPath(route.path) ?? "agent");
const rightPanelOpen = ref(false);

watch(
  () => route.path,
  (path) => {
    const routeWorkspace = workspaceForPath(path);
    if (routeWorkspace) workspace.value = routeWorkspace;
  },
);

function updateWorkspace(value: WorkspaceMode): void {
  workspace.value = value;
  const routeWorkspace = workspaceForPath(route.path);
  if (routeWorkspace === value) return;
  void router.push(value === "server" ? "/server/launch" : value === "agent" ? "/agent/chat" : "/");
}

function workspaceForPath(path: string): WorkspaceMode | undefined {
  if (path.startsWith("/server/")) return "server";
  if (path.startsWith("/agent/")) return "agent";
  if (path.startsWith("/launcher/")) return "launcher";
  return undefined;
}
</script>

<template>
  <div class="app-layout" :style="{ '--sl-software-logo': `url(${logoSvg})` }">
    <div class="app-background"></div>
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
          class="app-content"
          :aria-label="settingsMode ? '设置内容' : downloadMode ? '下载内容' : '工作区内容'"
        >
          <RouterView v-slot="{ Component }">
            <UiEntryBoundary :runtime-id="activeRuntimeId">
              <component :is="Component" />
            </UiEntryBoundary>
          </RouterView>
        </main>
        <aside
          class="right-sidebar"
          :class="{ open: rightPanelOpen && !settingsMode }"
          aria-label="右侧栏"
          :aria-hidden="settingsMode || !rightPanelOpen"
        ></aside>
      </div>
    </div>
  </div>
</template>
