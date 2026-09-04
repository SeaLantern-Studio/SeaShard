import { defineClientUiModule } from "@seashard/ui-sdk";
import { Info } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import { aboutUiServiceContract, type AboutUiService } from "../service";
import AboutPage from "./AboutPage.vue";

export default defineClientUiModule({
  apply(context) {
    const service = context.service<AboutUiService>(aboutUiServiceContract);
    const page = defineComponent({
      name: "AboutFeaturePage",
      setup: () => () => h(AboutPage, { service }),
    });
    context.slots.register(
      {
        name: "navigation.page",
        id: "about",
        path: "/settings/about",
        label: "关于",
        description: "关于 SeaShard",
        order: 20,
        icon: Info,
        navigation: true,
        placement: "settings",
        settingsGroup: "software",
      },
      page,
    );
  },
});
