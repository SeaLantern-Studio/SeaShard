import {
  pluginMarketContract,
  pluginMarketInstallContract,
  type PluginMarketInstallService,
  type PluginMarketService,
} from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { ShoppingBag } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import PluginMarketPage from "./PluginMarketPage.vue";

export default defineClientUiModule({
  apply(context) {
    const market = context.service<PluginMarketService>(pluginMarketContract);
    const installer = context.service<PluginMarketInstallService>(pluginMarketInstallContract);
    const page = defineComponent({
      name: "PluginMarketFeaturePage",
      setup: () => () => h(PluginMarketPage, { market, installer }),
    });

    context.slots.register(
      {
        name: "navigation.page",
        id: "plugin-market",
        path: "/settings/plugin-market",
        label: "插件市场",
        order: 0,
        icon: ShoppingBag,
        navigation: true,
        placement: "settings",
        settingsGroup: "software",
      },
      page,
    );
  },
});
