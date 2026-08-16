import { defineClientUiModule } from "@seashard/ui-sdk";
import { Info } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import { aboutUiManifest } from "../index";
import AboutPage from "./AboutPage.vue";

const AboutFeaturePage = defineComponent({
  name: "AboutFeaturePage",
  setup: () => () => h(AboutPage, { version: aboutUiManifest.version }),
});

export default defineClientUiModule({
  apply(context) {
    context.contribute("navigation.page", {
      id: "about",
      path: "/settings/about",
      label: "关于",
      description: "关于 SeaShard",
      order: 20,
      icon: Info,
      navigation: true,
      placement: "settings",
      component: AboutFeaturePage,
    });
  },
});
