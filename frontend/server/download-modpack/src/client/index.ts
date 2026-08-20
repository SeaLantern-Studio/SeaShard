import { serverModSourceContract, type ServerModSourceClientService } from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Package } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerModpackDownloadPage from "./ServerModpackDownloadPage.vue";

export default defineClientUiModule({
  apply(context) {
    const resources = context.service<ServerModSourceClientService>(serverModSourceContract);
    const page = defineComponent({
      name: "ServerModpackDownloadFeaturePage",
      setup: () => () => h(ServerModpackDownloadPage, { resources }),
    });

    context.contribute("navigation.page", {
      id: "server-download-modpack",
      path: "/server/download/modpack",
      label: "整合包",
      description: "浏览服务端整合包",
      order: 30,
      icon: Package,
      navigation: true,
      placement: "server-download",
      component: page,
    });
  },
});
