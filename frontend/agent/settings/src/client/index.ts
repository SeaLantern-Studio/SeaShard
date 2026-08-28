import { agentSettingsContract, type AgentSettingsService } from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { SlidersHorizontal } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import AgentSettingsPage from "./AgentSettingsPage.vue";

export default defineClientUiModule({
  apply(context) {
    const settings = context.service<AgentSettingsService>(agentSettingsContract);
    const page = defineComponent({
      name: "AgentSettingsFeaturePage",
      setup: () => () => h(AgentSettingsPage, { settings }),
    });

    context.slots.register(
      {
        name: "navigation.page",
        id: "agent-settings-general",
        path: "/agent/settings/general",
        label: "常规",
        order: -10,
        icon: SlidersHorizontal,
        navigation: true,
        placement: "agent-settings",
      },
      page,
    );
  },
});
