import {
  serverInstanceManagerContract,
  serverRuntimeContract,
  type ServerInstanceClientService,
  type ServerRuntimeClientService,
} from "@seashard/contracts";
import { serverInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Archive } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerWorldSavePage from "./ServerWorldSavePage.vue";

export default defineClientUiModule({
  apply(context) {
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const runtime = context.service<ServerRuntimeClientService>(serverRuntimeContract);
    const page = defineComponent({
      name: "ServerSavesFeaturePage",
      setup: () => () =>
        h(ServerWorldSavePage, { instances, runtime, selection: serverInstanceSelection }),
    });

    context.contribute("navigation.page", {
      id: "server-saves",
      path: "/server/saves",
      label: "存档",
      description: "查看和切换服务器存档",
      order: 25,
      icon: Archive,
      navigation: false,
      placement: "main",
      component: page,
    });
  },
});
