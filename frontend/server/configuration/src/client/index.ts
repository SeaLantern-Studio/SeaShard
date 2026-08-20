import {
  serverConfigurationContract,
  serverInstanceManagerContract,
  type ServerConfigurationClientService,
  type ServerInstanceClientService,
} from "@seashard/contracts";
import { serverInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { FileCog } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerConfigurationPage from "./ServerConfigurationPage.vue";

export default defineClientUiModule({
  apply(context) {
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const configuration = context.service<ServerConfigurationClientService>(
      serverConfigurationContract,
    );
    const page = defineComponent({
      name: "ServerConfigurationFeaturePage",
      setup: () => () =>
        h(ServerConfigurationPage, {
          instances,
          configuration,
          selection: serverInstanceSelection,
        }),
    });

    context.contribute("navigation.page", {
      id: "server-configuration",
      path: "/server/configuration",
      label: "配置管理",
      description: "修改服务器属性与插件配置文件",
      order: 20,
      icon: FileCog,
      navigation: false,
      placement: "main",
      component: page,
    });
  },
});
