import {
  serverInstanceManagerContract,
  type ServerInstanceClientService,
} from "@seashard/contracts";
import { serverInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Plug } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerPluginsPage from "./ServerPluginsPage.vue";

export default defineClientUiModule({
  apply(context) {
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const page = defineComponent({
      name: "ServerPluginsFeaturePage",
      setup: () => () => h(ServerPluginsPage, { instances, selection: serverInstanceSelection }),
    });
    context.slots.register(
      {
        name: "navigation.page",
        id: "server-plugins",
        path: "/server/plugins",
        label: "插件",
        order: 32,
        icon: Plug,
        navigation: true,
        placement: "server",
      },
      page,
    );
  },
});
