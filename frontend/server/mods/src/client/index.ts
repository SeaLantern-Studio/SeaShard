import {
  serverInstanceManagerContract,
  serverRuntimeContract,
  type ServerInstanceClientService,
  type ServerRuntimeClientService,
} from "@seashard/contracts";
import { serverInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Puzzle } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerModManagementPage from "./ServerModManagementPage.vue";

export default defineClientUiModule({
  apply(context) {
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const runtime = context.service<ServerRuntimeClientService>(serverRuntimeContract);
    const page = defineComponent({
      name: "ServerModsFeaturePage",
      setup: () => () =>
        h(ServerModManagementPage, { instances, runtime, selection: serverInstanceSelection }),
    });

    context.slots.register(
      {
        name: "navigation.page",
        id: "server-mods",
        path: "/server/mods",
        label: "Mod",
        description: "管理服务器已安装的 Mod",
        order: 30,
        icon: Puzzle,
        navigation: false,
        placement: "main",
      },
      page,
    );
  },
});
