import { defineComponent } from "vue";
import { createRouter, createWebHistory } from "vue-router";

const EmptyRoute = defineComponent({
  name: "SeaShardServerWebEmptyRoute",
  render: () => null,
});

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "server-web-root", component: EmptyRoute },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
