import {
  agentModelConfigurationContract,
  type AgentModelConfigurationClientService,
} from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";
import { Settings2 } from "lucide-vue-next";
import { defineComponent, h } from "vue";
import AgentProviderSettingsPage from "./AgentProviderSettingsPage.vue";

export default defineClientUiModule({
  apply(context) {
    const configuration = context.service<AgentModelConfigurationClientService>(
      agentModelConfigurationContract,
    );
    const page = defineComponent({
      name: "AgentProviderSettingsFeaturePage",
      setup: () => () => h(AgentProviderSettingsPage, { configuration }),
    });

    context.slots.register(
      {
        name: "navigation.page",
        id: "agent-settings-providers",
        path: "/agent/settings/providers",
        label: "供应商",
        order: 0,
        icon: Settings2,
        navigation: true,
        placement: "agent-settings",
      },
      page,
    );
  },
});
