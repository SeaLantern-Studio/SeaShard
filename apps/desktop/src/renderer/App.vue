<script setup lang="ts">
import { computed } from "vue";
import { RouterView, useRoute } from "vue-router";
import AppHeader from "./AppHeader.vue";
import AppSidebar from "./AppSidebar.vue";
import UiEntryBoundary from "./UiEntryBoundary.vue";

const route = useRoute();
const activeRuntimeId = computed(() =>
  typeof route.meta.runtimeId === "string" ? route.meta.runtimeId : undefined,
);
</script>

<template>
  <div class="app-layout">
    <div class="app-background"></div>
    <AppSidebar />
    <div class="app-main">
      <AppHeader />
      <main class="app-content" aria-label="首页内容">
        <RouterView v-slot="{ Component }">
          <UiEntryBoundary :runtime-id="activeRuntimeId">
            <component :is="Component" />
          </UiEntryBoundary>
        </RouterView>
      </main>
    </div>
  </div>
</template>
