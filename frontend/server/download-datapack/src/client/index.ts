import {
  serverInstanceManagerContract,
  serverModSourceContract,
  type ServerInstanceClientService,
  type ServerModSourceClientService,
} from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Archive } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerDatapackDownloadPage from "./ServerDatapackDownloadPage.vue";

export default defineClientUiModule({
  apply(context) {
    const resources = context.service<ServerModSourceClientService>(serverModSourceContract);
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const page = defineComponent({
      name: "ServerDatapackDownloadFeaturePage",
      setup: () => () => h(ServerDatapackDownloadPage, { resources, instances }),
    });

    context.contribute("navigation.page", {
      id: "server-download-datapack",
      path: "/server/download/datapack",
      label: "数据包",
      description: "浏览并安装服务端数据包",
      order: 40,
      icon: Archive,
      navigation: true,
      placement: "server-download",
      component: page,
    });
  },
});
