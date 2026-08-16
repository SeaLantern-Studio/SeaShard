import { defineComponent } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";

const EmptyRoute = defineComponent({
  name: "SeaShardEmptyRoute",
  render: () => null,
});

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      name: "home",
      component: EmptyRoute,
    },
  ],
});
