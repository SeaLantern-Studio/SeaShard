import {
  serverInstanceManagerContract,
  serverRuntimeContract,
  serverSettingsContract,
  type ServerInstanceClientService,
  type ServerRuntimeClientService,
  type ServerSettingsClientService,
} from "@seashard/contracts";
import { serverInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { SlidersHorizontal } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerInstanceSettingsPage from "./ServerInstanceSettingsPage.vue";

export default defineClientUiModule({
  apply(context) {
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const runtime = context.service<ServerRuntimeClientService>(serverRuntimeContract);
    const settings = context.service<ServerSettingsClientService>(serverSettingsContract);
    const page = defineComponent({
      name: "ServerInstanceSettingsFeaturePage",
      setup: () => () =>
        h(ServerInstanceSettingsPage, {
          runtime,
          instances,
          settings,
          selection: serverInstanceSelection,
        }),
    });

    context.contribute("navigation.page", {
      id: "server-instance-settings",
      path: "/server/settings",
      label: "设置",
      description: "修改当前服务器实例的启动参数",
      order: 5,
      icon: SlidersHorizontal,
      navigation: false,
      placement: "main",
      component: page,
    });
  },
});
