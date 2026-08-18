import { defineClientUiModule } from "@seashard/ui-sdk";
import { Coffee } from "lucide-vue-next";
import JavaSettingsPage from "./JavaSettingsPage.vue";

export default defineClientUiModule({
  apply(context) {
    context.contribute("navigation.page", {
      id: "java-settings",
      path: "/settings/game/java",
      label: "Java",
      description: "Minecraft Java 运行环境",
      order: 10,
      icon: Coffee,
      navigation: true,
      placement: "settings",
      settingsGroup: "game",
      component: JavaSettingsPage,
    });
  },
});
