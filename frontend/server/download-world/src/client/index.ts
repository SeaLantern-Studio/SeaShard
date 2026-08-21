import {
  serverInstanceManagerContract,
  serverModSourceContract,
  serverRuntimeContract,
  type ServerInstanceClientService,
  type ServerModSourceClientService,
  type ServerRuntimeClientService,
} from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Folder } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerWorldDownloadPage from "./ServerWorldDownloadPage.vue";

export default defineClientUiModule({
  apply(context) {
    const resources = context.service<ServerModSourceClientService>(serverModSourceContract);
    const instances = context.service<ServerInstanceClientService>(serverInstanceManagerContract);
    const runtime = context.service<ServerRuntimeClientService>(serverRuntimeContract);
    const page = defineComponent({
      name: "ServerWorldDownloadFeaturePage",
      setup: () => () => h(ServerWorldDownloadPage, { resources, instances, runtime }),
    });

    context.contribute("navigation.page", {
      id: "server-download-world",
      path: "/server/download/world",
      label: "世界",
      description: "浏览服务端世界资源",
      order: 50,
      icon: Folder,
      navigation: true,
      placement: "server-download",
      component: page,
    });
  },
});
