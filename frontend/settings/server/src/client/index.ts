import {
  serverSettingsContract,
  type SeaShardDesktopApi,
  type ServerSettingsClientService,
} from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Download } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerDownloadSettingsPage from "./ServerDownloadSettingsPage.vue";

export default defineClientUiModule({
  apply(context) {
    const desktopApi = (window as Window & { seashard: SeaShardDesktopApi }).seashard;
    const settings = context.service<ServerSettingsClientService>(serverSettingsContract);
    const page = defineComponent({
      name: "ServerDownloadSettingsFeaturePage",
      setup: () => () =>
        h(ServerDownloadSettingsPage, {
          selectDirectory: () => desktopApi.dialog.selectDirectory(),
          settings,
        }),
    });

    context.contribute("navigation.page", {
      id: "server-download-settings",
      path: "/settings/server/download",
      label: "下载",
      description: "服务器资源下载位置",
      order: 10,
      icon: Download,
      navigation: true,
      placement: "settings",
      settingsGroup: "server",
      component: page,
    });
  },
});
