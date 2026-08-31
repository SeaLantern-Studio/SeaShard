import type { SeaShardDesktopApi } from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Network } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import HostConnectionsPage from "./HostConnectionsPage.vue";

const HostConnectionsFeaturePage = defineComponent({
  name: "HostConnectionsFeaturePage",
  setup: () => {
    const desktopApi = (window as Window & { seashard: SeaShardDesktopApi }).seashard;
    return () => h(HostConnectionsPage, { hosts: desktopApi.hosts });
  },
});

export default defineClientUiModule({
  apply(context) {
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
      HostConnectionsFeaturePage,
    );
  },
});
