import {
  serverInstanceManagerContract,
  type ServerInstanceClientService,
} from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Play } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerLaunchPage from "./ServerLaunchPage.vue";

export default defineClientUiModule({
  apply(context) {
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const page = defineComponent({
      name: "ServerLaunch",
      setup: () => () => h(ServerLaunchPage, { instances }),
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
      component: page,
    });
  },
});
