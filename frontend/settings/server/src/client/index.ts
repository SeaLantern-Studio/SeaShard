import {
  serverSettingsContract,
  type SeaShardDesktopApi,
  type ServerSettingsClientService,
} from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Download, Rocket } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import ServerDownloadSettingsPage from "./ServerDownloadSettingsPage.vue";
import ServerStartupSettingsPage from "./ServerStartupSettingsPage.vue";

export default defineClientUiModule({
  apply(context) {
    const desktopApi = (window as Window & { seashard?: SeaShardDesktopApi }).seashard;
    const settings = context.service<ServerSettingsClientService>(serverSettingsContract);
    const startupPage = defineComponent({
      name: "ServerStartupSettingsFeaturePage",
      setup: () => () => h(ServerStartupSettingsPage, { settings }),
    });
    const downloadPage = defineComponent({
      name: "ServerDownloadSettingsFeaturePage",
      setup: () => () =>
        h(ServerDownloadSettingsPage, {
          ...(desktopApi ? { selectDirectory: () => desktopApi.dialog.selectDirectory() } : {}),
          settings,
        }),
    });

    context.slots.register(
      {
        name: "navigation.page",
        id: "server-startup-settings",
        path: "/server-settings/startup",
        label: "启动",
        description: "服务器默认启动参数",
        order: 5,
        icon: Rocket,
        navigation: true,
        placement: "settings",
        settingsGroup: "server",
      },
      startupPage,
    );

    context.slots.register(
      {
        name: "navigation.page",
        id: "server-download-settings",
        path: "/server-settings/download",
        label: "下载",
        description: "服务器资源下载位置",
        order: 10,
        icon: Download,
        navigation: true,
        placement: "settings",
        settingsGroup: "server",
      },
      downloadPage,
    );
  },
});
