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
const workspace = ref<WorkspaceMode>("agent");
const rightPanelOpen = ref(false);
</script>

<template>
  <div class="app-layout">
    <div class="app-background"></div>
    <AppSidebar :workspace="workspace" />
    <div class="app-main">
      <AppHeader
        :workspace="workspace"
        :right-panel-open="rightPanelOpen"
        @update:workspace="workspace = $event"
        @toggle-right-panel="rightPanelOpen = !rightPanelOpen"
      />
      <div class="workspace-frame">
        <main class="app-content" aria-label="工作区内容">
          <RouterView v-slot="{ Component }">
            <UiEntryBoundary :runtime-id="activeRuntimeId">
              <component :is="Component" />
            </UiEntryBoundary>
          </RouterView>
        </main>
        <aside
          class="right-sidebar"
          :class="{ open: rightPanelOpen }"
          aria-label="右侧栏"
          :aria-hidden="!rightPanelOpen"
        ></aside>
      </div>
    </div>
  </div>
</template>
