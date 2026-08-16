import {
  defineClientUiModule,
  uiAppearanceContract,
  type UiAppearanceService,
} from "@seashard/ui-sdk";
import { PaintRoller } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import PersonalizationPage from "./PersonalizationPage.vue";

export default defineClientUiModule({
  apply(context) {
    const appearance = context.service<UiAppearanceService>(uiAppearanceContract);
    const page = defineComponent({
      name: "PersonalizationFeaturePage",
      setup: () => () => h(PersonalizationPage, { appearance }),
    });

    context.contribute("navigation.page", {
      id: "personalization",
      path: "/settings/personalization",
      label: "个性化",
      description: "颜色主题与外观",
      order: 10,
      icon: PaintRoller,
      navigation: true,
      placement: "settings",
      settingsGroup: "software",
      component: page,
    });
  },
});
