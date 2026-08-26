import {
  serverInstanceManagerContract,
  serverRuntimeContract,
  type ServerInstanceClientService,
  type ServerRuntimeClientService,
} from "@seashard/contracts";
import { serverInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Play } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerLaunchPage from "./ServerLaunchPage.vue";

export default defineClientUiModule({
  apply(context) {
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const runtime = context.service<ServerRuntimeClientService>(serverRuntimeContract);
    const page = defineComponent({
      name: "ServerLaunchFeaturePage",
      setup: () => () =>
        h(ServerLaunchPage, { instances, runtime, selection: serverInstanceSelection }),
    });

    context.slots.register(
      {
        name: "navigation.page",
        id: "server-launch",
        path: "/server/launch",
        label: "启动",
        description: "启动和切换服务器实例",
        order: 0,
        icon: Play,
        navigation: false,
        placement: "main",
      },
      page,
    );
  },
});
