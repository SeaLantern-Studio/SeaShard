import type { ClientUiModuleLoader } from "@seashard/ui-runtime";

export const agentClientModuleLoaders: Readonly<Record<string, ClientUiModuleLoader>> = {
  "seashard.agent-conversation-ui/agent-conversation.client": {
    load: () => import("@seashard/agent-conversation-ui/client"),
  },
  "seashard.agent-settings-ui/agent-settings.client": {
    load: () => import("@seashard/agent-settings-ui/client"),
  },
  "seashard.agent-settings-provider-ui/agent-settings-provider.client": {
    load: () => import("@seashard/agent-settings-provider-ui/client"),
  },
};
