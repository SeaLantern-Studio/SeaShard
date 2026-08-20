import {
  serverInstanceManagerContract,
  serverRuntimeContract,
  type ServerInstanceClientService,
  type ServerRuntimeClientService,
} from "@seashard/contracts";
import { serverInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { LayoutDashboard } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerOverviewPage from "./ServerOverviewPage.vue";

export default defineClientUiModule({
  apply(context) {
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const runtime = context.service<ServerRuntimeClientService>(serverRuntimeContract);
    const page = defineComponent({
      name: "ServerOverviewFeaturePage",
      setup: () => () =>
        h(ServerOverviewPage, { instances, runtime, selection: serverInstanceSelection }),
    });

    context.contribute("navigation.page", {
      id: "server-overview",
      path: "/server/overview",
      label: "概览",
      description: "查看当前服务器的状态与实例信息",
      order: -10,
      icon: LayoutDashboard,
      navigation: false,
      placement: "main",
      component: page,
    });
  },
});
