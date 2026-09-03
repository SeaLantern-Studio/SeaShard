import { agentClientModuleLoaders } from "@seashard/agent-client-features/loaders";
import { serverClientModuleLoaders } from "@seashard/server-client-features/loaders";
import type { ClientUiModuleLoader } from "@seashard/ui-runtime";

export const builtInClientModuleLoaders: Readonly<Record<string, ClientUiModuleLoader>> = {
  "seashard.host-connections-ui/host-connections.client": {
    load: () => import("@seashard/host-connections-ui/client"),
  },
  ...agentClientModuleLoaders,
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
};
