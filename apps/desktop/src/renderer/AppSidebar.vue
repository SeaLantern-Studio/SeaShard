<script setup lang="ts">
import { Home } from "lucide-vue-next";
import { nextTick, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import logoSvg from "./assets/logo.svg";

const router = useRouter();
const sidebarNav = ref<HTMLElement>();
const navItem = ref<HTMLElement>();
const navIndicator = ref<HTMLElement>();

function navigateHome(): void {
  void router.push("/");
}

onMounted(() => {
  void nextTick(() => {
    if (!sidebarNav.value || !navItem.value || !navIndicator.value) return;
    const navRect = sidebarNav.value.getBoundingClientRect();
    const itemRect = navItem.value.getBoundingClientRect();
    const top =
      itemRect.top - navRect.top + sidebarNav.value.scrollTop + (itemRect.height - 16) / 2;
    navIndicator.value.style.top = `${top}px`;
  });
});
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-logo" @click="navigateHome">
      <div class="logo-icon">
        <img :src="logoSvg" width="28" height="28" alt="SeaShard" draggable="false" />
      </div>
      <span class="logo-text">SeaShard</span>
    </div>

    <nav ref="sidebarNav" class="sidebar-nav" aria-label="主导航">
      <div ref="navIndicator" class="nav-active-indicator"></div>
      <div class="nav-group">
        <button ref="navItem" type="button" class="nav-item active" @click="navigateHome">
          <Home class="nav-icon" :size="20" :stroke-width="1.8" />
          <span class="nav-label">首页</span>
        </button>
      </div>
    </nav>
  </aside>
</template>
