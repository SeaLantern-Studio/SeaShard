<script setup lang="ts">
import { useClientUiRuntime } from "@seashard/ui-runtime";
import { Home } from "lucide-vue-next";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import logoSvg from "./assets/logo.svg";

const runtime = useClientUiRuntime();
const router = useRouter();
const route = useRoute();
const sidebarNav = ref<HTMLElement>();
const navIndicator = ref<HTMLElement>();
const visiblePages = computed(() =>
  runtime.pages.value.filter((page) => page.navigation !== false),
);
const mainPages = computed(() => visiblePages.value.filter((page) => page.placement !== "bottom"));
const bottomPages = computed(() =>
  visiblePages.value.filter((page) => page.placement === "bottom"),
);
let indicatorFrame: number | undefined;

function navigate(path: string): void {
  void router.push(path);
}

function isActive(path: string): boolean {
  return path === "/" ? route.path === "/" : route.path.startsWith(path);
}

function updateNavIndicator(): void {
  if (indicatorFrame !== undefined) cancelAnimationFrame(indicatorFrame);
  indicatorFrame = requestAnimationFrame(() => {
    indicatorFrame = undefined;
    const nav = sidebarNav.value;
    const indicator = navIndicator.value;
    const item = nav?.querySelector<HTMLElement>(".nav-item.active");
    if (!nav || !indicator || !item) return;
    const navRect = nav.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const top = itemRect.top - navRect.top + nav.scrollTop + (itemRect.height - 16) / 2;
    indicator.style.top = `${top}px`;
  });
}

watch([() => route.path, visiblePages], () => void nextTick(updateNavIndicator), { flush: "post" });

onMounted(() => {
  updateNavIndicator();
  window.addEventListener("resize", updateNavIndicator);
});

onUnmounted(() => {
  if (indicatorFrame !== undefined) cancelAnimationFrame(indicatorFrame);
  window.removeEventListener("resize", updateNavIndicator);
});
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-logo" @click="navigate('/')">
      <div class="logo-icon">
        <img :src="logoSvg" width="28" height="28" alt="SeaShard" draggable="false" />
      </div>
      <span class="logo-text">SeaShard</span>
    </div>

    <nav ref="sidebarNav" class="sidebar-nav" aria-label="主导航">
      <div ref="navIndicator" class="nav-active-indicator"></div>
      <div class="nav-group">
        <button
          type="button"
          class="nav-item"
          :class="{ active: isActive('/') }"
          @click="navigate('/')"
        >
          <Home class="nav-icon" :size="20" :stroke-width="1.8" />
          <span class="nav-label">首页</span>
        </button>

        <button
          v-for="page in mainPages"
          :key="page.id"
          type="button"
          class="nav-item"
          :class="{ active: isActive(page.path) }"
          @click="navigate(page.path)"
        >
          <component
            :is="page.icon"
            v-if="page.icon"
            class="nav-icon"
            :size="20"
            :stroke-width="1.8"
          />
          <span class="nav-label">{{ page.label }}</span>
        </button>
      </div>

      <div v-if="bottomPages.length" class="nav-group lower-side">
        <button
          v-for="page in bottomPages"
          :key="page.id"
          type="button"
          class="nav-item"
          :class="{ active: isActive(page.path) }"
          @click="navigate(page.path)"
        >
          <component
            :is="page.icon"
            v-if="page.icon"
            class="nav-icon"
            :size="20"
            :stroke-width="1.8"
          />
          <span class="nav-label">{{ page.label }}</span>
        </button>
      </div>
    </nav>
  </aside>
</template>
