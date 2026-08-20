import { serverModSourceContract, type ServerModSourceClientService } from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Puzzle } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerModDownloadPage from "./ServerModDownloadPage.vue";

export default defineClientUiModule({
  apply(context) {
    const mods = context.service<ServerModSourceClientService>(serverModSourceContract);
    const page = defineComponent({
      name: "ServerModDownloadFeaturePage",
      setup: () => () => h(ServerModDownloadPage, { mods }),
    });

    context.contribute("navigation.page", {
      id: "server-download-mod",
      path: "/server/download/mod",
      label: "Mod",
      description: "浏览服务端 Mod",
      order: 20,
      icon: Puzzle,
      navigation: true,
      placement: "server-download",
      component: page,
    });
  },
});
