import { defineClientUiModule } from "@seashard/ui-sdk";
import { Info } from "lucide-vue-next";
import { defineComponent } from "vue";

const AboutPage = defineComponent({
  name: "AboutFeaturePage",
  render: () => null,
});

export default defineClientUiModule({
  apply(context) {
    context.contribute("navigation.page", {
      id: "about",
      path: "/about",
      label: "关于",
      description: "关于 SeaShard",
      order: 20,
      icon: Info,
      navigation: true,
      placement: "bottom",
      component: AboutPage,
    });
  },
});
