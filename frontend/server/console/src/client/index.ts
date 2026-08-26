import {
  serverInstanceManagerContract,
  serverRuntimeContract,
  type ServerInstanceClientService,
  type ServerRuntimeClientService,
} from "@seashard/contracts";
import { serverInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Terminal } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerConsolePage from "./ServerConsolePage.vue";

export default defineClientUiModule({
  apply(context) {
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const runtime = context.service<ServerRuntimeClientService>(serverRuntimeContract);
    const page = defineComponent({
      name: "ServerConsoleFeaturePage",
      setup: () => () =>
        h(ServerConsolePage, { instances, runtime, selection: serverInstanceSelection }),
    });

    context.slots.register(
      {
        name: "navigation.page",
        id: "server-console",
        path: "/server/console",
        label: "控制台",
        description: "查看服务器日志并发送命令",
        order: 10,
        icon: Terminal,
        navigation: false,
        placement: "main",
      },
      page,
    );
  },
});
