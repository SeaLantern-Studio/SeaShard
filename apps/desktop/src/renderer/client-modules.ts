import type { ClientUiModuleLoader } from "@seashard/ui-runtime";
import { serverClientModuleLoaders } from "@seashard/server-client-features/loaders";

export const builtInClientModuleLoaders: Readonly<Record<string, ClientUiModuleLoader>> = {
  "seashard.host-connections-ui/host-connections.client": {
    load: () => import("@seashard/host-connections-ui/client"),
  },
  "seashard.agent-conversation-ui/agent-conversation.client": {
    load: () => import("@seashard/agent-conversation-ui/client"),
  },
  "seashard.agent-settings-ui/agent-settings.client": {
    load: () => import("@seashard/agent-settings-ui/client"),
  },
  "seashard.agent-settings-provider-ui/agent-settings-provider.client": {
    load: () => import("@seashard/agent-settings-provider-ui/client"),
  },
  "seashard.about-ui/about.client": {
    load: () => import("@seashard/about-ui/client"),
  },
  "seashard.runtime-diagnostics-ui/runtime-diagnostics.client": {
    load: () => import("@seashard/runtime-diagnostics-ui/client"),
  },
  "seashard.personalization-ui/personalization.client": {
    load: () => import("@seashard/personalization-ui/client"),
  },
  "seashard.plugin-settings-ui/plugin-settings.client": {
    load: () => import("@seashard/plugin-settings-ui/client"),
  },
  "seashard.plugin-market-ui/plugin-market.client": {
    load: () => import("@seashard/plugin-market-ui/client"),
  },
  ...serverClientModuleLoaders,
  "seashard.server-settings-ui/server-settings.client": {
    load: () => import("@seashard/server-settings-ui/client"),
  },
};
