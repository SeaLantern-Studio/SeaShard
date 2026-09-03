import { defineClientUiModule } from "@seashard/ui-sdk";
import { Gauge } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerWebDashboardPage from "./ServerWebDashboardPage.vue";

export { default as ServerWebDashboardPage } from "./ServerWebDashboardPage.vue";

export default defineClientUiModule({
  apply(context) {
    const page = defineComponent({
      name: "ServerWebDashboardFeaturePage",
      setup: () => () => h(ServerWebDashboardPage),
    });
    context.slots.register(
      {
        name: "navigation.page",
        id: "server-web-dashboard",
        path: "/",
        label: "服务器",
        order: -100,
        icon: Gauge,
        navigation: false,
        placement: "main",
      },
      page,
    );
  },
});
