import {
  serverInstanceManagerContract,
  serverRuntimeContract,
  type ServerInstanceClientService,
  type ServerRuntimeClientService,
} from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Play, Terminal } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerConsolePage from "./ServerConsolePage.vue";
import ServerLaunchPage from "./ServerLaunchPage.vue";

export default defineClientUiModule({
  apply(context) {
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const runtime = context.service<ServerRuntimeClientService>(serverRuntimeContract);
    const launchPage = defineComponent({
      name: "ServerLaunch",
      setup: () => () => h(ServerLaunchPage, { instances, runtime }),
    });
    const consolePage = defineComponent({
      name: "ServerConsole",
      setup: () => () => h(ServerConsolePage, { instances, runtime }),
    });
    context.contribute("navigation.page", {
      id: "server-launch",
      path: "/server/launch",
      label: "启动",
      description: "启动和切换服务器实例",
      order: 0,
      icon: Play,
      navigation: false,
      placement: "main",
      component: launchPage,
    });
    context.contribute("navigation.page", {
      id: "server-console",
      path: "/server/console",
      label: "控制台",
      description: "查看服务器日志并发送命令",
      order: 10,
      icon: Terminal,
      navigation: false,
      placement: "main",
      component: consolePage,
    });
  },
});
