import { javaRuntimeManagerContract, type JavaRuntimeClientService } from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Coffee } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import JavaSettingsPage from "./JavaSettingsPage.vue";

export default defineClientUiModule({
  apply(context) {
    const javaRuntime = context.service<JavaRuntimeClientService>(javaRuntimeManagerContract);
    const page = defineComponent({
      name: "JavaSettingsFeaturePage",
      setup: () => () => h(JavaSettingsPage, { javaRuntime }),
    });
    context.slots.register(
      {
        name: "navigation.page",
        id: "java-settings",
        path: "/settings/game/java",
        label: "Java",
        description: "Minecraft Java 运行环境",
        order: 10,
        icon: Coffee,
        navigation: true,
        placement: "settings",
        settingsGroup: "game",
      },
      page,
    );
  },
});
