<script setup lang="ts">
import { useClientUiRuntime } from "@seashard/ui-runtime";
import { Cmz_Toast, useToast } from "cmzya-modern-ui";
import { computed, ref } from "vue";
import { RouterLink, RouterView } from "vue-router";
import { loadServerClientBootstrap } from "./client-runtime";
import { router } from "./router";

const runtime = useClientUiRuntime();
const toast = useToast();
const authenticated = ref(false);
const navigationPages = computed(() =>
  runtime.pages.value.filter(({ navigation }) => navigation !== false),
);
let authenticationTask: Promise<void> = Promise.resolve();

function setAuthenticated(value: boolean): void {
  authenticationTask = authenticationTask
    .then(async () => {
      authenticated.value = value;
      if (!value) {
        await router.replace("/");
        await runtime.dispose();
        return;
      }
      await runtime.reconcile(await loadServerClientBootstrap());
    })
    .catch((error) => {
      runtime.failBootstrap(error);
      toast.error({
        title: "加载服务器管理页面失败",
        description: error instanceof Error ? error.message : String(error),
      });
    });
}
</script>

<template>
  <nav v-if="authenticated && navigationPages.length" class="server-web-global-nav">
    <RouterLink to="/">控制台</RouterLink>
    <RouterLink v-for="page in navigationPages" :key="page.entryToken" :to="page.path">
      {{ page.label }}
    </RouterLink>
  </nav>
  <section :class="{ 'server-feature-surface': authenticated && $route.path !== '/' }">
    <RouterView v-slot="{ Component }">
      <component :is="Component" @authenticated="setAuthenticated" />
    </RouterView>
  </section>
  <Cmz_Toast />
</template>
