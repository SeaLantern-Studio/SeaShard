import { pluginManagementContract, type PluginManagementService } from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Puzzle } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import PluginSettingsPage from "./PluginSettingsPage.vue";

export default defineClientUiModule({
  apply(context) {
    const management = context.service<PluginManagementService>(pluginManagementContract);
    const page = defineComponent({
      name: "PluginSettingsFeaturePage",
      setup: () => () => h(PluginSettingsPage, { management }),
    });

    context.slots.register(
      {
        name: "navigation.page",
        id: "plugin-settings",
        path: "/settings/plugins",
        label: "插件设置",
        order: 10,
        icon: Puzzle,
        navigation: true,
        placement: "settings",
        settingsGroup: "software",
      },
      page,
    );
  },
});
