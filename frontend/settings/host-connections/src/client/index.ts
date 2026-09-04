import { defineClientUiModule } from "@seashard/ui-sdk";
import { Network } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import { hostConnectionsUiServiceContract, type HostConnectionsUiService } from "../service";
import HostConnectionsPage from "./HostConnectionsPage.vue";

export default defineClientUiModule({
  apply(context) {
    const hosts = context.service<HostConnectionsUiService>(hostConnectionsUiServiceContract);
    const page = defineComponent({
      name: "HostConnectionsFeaturePage",
      setup: () => () => h(HostConnectionsPage, { hosts }),
    });
    context.slots.register(
      {
        name: "navigation.page",
        id: "host-connections",
        path: "/settings/hosts",
        label: "Host 连接",
        description: "Host 连接",
        order: 5,
        icon: Network,
        navigation: true,
        placement: "settings",
        settingsGroup: "software",
      },
      page,
    );
  },
});
