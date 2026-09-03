import { ServerWebDashboardPage } from "@seashard/server-web-dashboard-ui/client";
import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "server-web-dashboard", component: ServerWebDashboardPage },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
