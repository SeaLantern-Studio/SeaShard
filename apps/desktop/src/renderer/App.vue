<script setup lang="ts">
import { useClientUiRuntime } from "@seashard/ui-runtime";
import { Cmz_Badge, Cmz_Spinner } from "cmzya-modern-ui";
import { Activity, AlertTriangle, Boxes, Settings2 } from "lucide-vue-next";
import { computed } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import UiEntryBoundary from "./UiEntryBoundary.vue";

const runtime = useClientUiRuntime();
const route = useRoute();
const pages = runtime.pages;
const failures = runtime.failures;
const activePage = computed(() => pages.value.find((page) => page.routeName === route.name));
const activeRuntimeId = computed(() =>
  typeof route.meta.runtimeId === "string" ? route.meta.runtimeId : undefined,
);
</script>

<template>
  <div class="app-frame">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">S</span>
        <div>
          <p>SEASHARD</p>
          <strong>Desktop</strong>
        </div>
      </div>

      <nav class="navigation" aria-label="主导航">
        <p class="navigation-label">工作区</p>
        <RouterLink v-for="page in pages" :key="page.id" :to="page.path" class="navigation-item">
          <Activity v-if="page.id === 'runtime-diagnostics'" :size="17" :stroke-width="1.8" />
          <Boxes v-else :size="17" :stroke-width="1.8" />
          <span>{{ page.label }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-footer">
        <div class="runtime-summary">
          <span
            class="runtime-indicator"
            :class="{ 'runtime-indicator--ready': runtime.ready.value }"
          ></span>
          <div>
            <strong>{{ runtime.ready.value ? "UI Runtime 已就绪" : "正在装配界面" }}</strong>
            <span>{{ pages.length }} 个页面贡献</span>
          </div>
        </div>
        <div class="sidebar-meta">
          <Settings2 :size="14" />
          <span>Desktop Client</span>
        </div>
      </div>
    </aside>

    <main class="workspace">
      <header class="workspace-bar">
        <div>
          <p>{{ activePage?.description ?? "SeaShard 组件化桌面客户端" }}</p>
          <strong>{{ activePage?.label ?? "正在启动" }}</strong>
        </div>
        <Cmz_Badge text="Electron" size="small" />
      </header>

      <div v-if="failures.length" class="failure-strip" role="status">
        <AlertTriangle :size="16" />
        <span>{{ failures.length }} 个 UI Entry 需要处理</span>
      </div>

      <section v-if="!runtime.ready.value" class="shell-state">
        <Cmz_Spinner size="lg" />
        <div>
          <strong>正在装配 Client Entry</strong>
          <p>Main 正在发布当前窗口允许激活的界面组件。</p>
        </div>
      </section>

      <section v-else-if="pages.length === 0" class="shell-state shell-state--failed">
        <AlertTriangle :size="24" />
        <div>
          <strong>没有可用页面</strong>
          <p v-if="failures[0]">{{ failures[0].runtimeId }}：{{ failures[0].message }}</p>
          <p v-else>当前 Client Entry 图为空。</p>
        </div>
      </section>

      <div v-else class="page-host">
        <RouterView v-slot="{ Component }">
          <UiEntryBoundary :runtime-id="activeRuntimeId">
            <component :is="Component" />
          </UiEntryBoundary>
        </RouterView>
      </div>
    </main>
  </div>
</template>
