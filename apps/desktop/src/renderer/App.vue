<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterView, useRoute } from "vue-router";
import AppHeader from "./AppHeader.vue";
import AppSidebar from "./AppSidebar.vue";
import UiEntryBoundary from "./UiEntryBoundary.vue";
import type { WorkspaceMode } from "./workspace-layout";

const route = useRoute();
const activeRuntimeId = computed(() =>
  typeof route.meta.runtimeId === "string" ? route.meta.runtimeId : undefined,
);
const settingsMode = computed(() => route.path.startsWith("/settings/"));
const workspace = ref<WorkspaceMode>("agent");
const rightPanelOpen = ref(false);
</script>

<template>
  <div class="app-layout">
    <div class="app-background"></div>
    <AppSidebar :workspace="workspace" :settings-mode="settingsMode" />
    <div class="app-main">
      <AppHeader
        :workspace="workspace"
        :settings-mode="settingsMode"
        :right-panel-open="rightPanelOpen"
        @update:workspace="workspace = $event"
        @toggle-right-panel="rightPanelOpen = !rightPanelOpen"
      />
      <div class="workspace-frame">
        <main class="app-content" :aria-label="settingsMode ? '设置内容' : '工作区内容'">
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
