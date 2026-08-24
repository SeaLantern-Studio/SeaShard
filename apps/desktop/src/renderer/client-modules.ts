import type { ClientUiModuleLoader } from "@seashard/ui-runtime";

export const builtInClientModuleLoaders: Readonly<Record<string, ClientUiModuleLoader>> = {
  "seashard.agent-conversation-ui/agent-conversation.client": {
    load: () => import("@seashard/agent-conversation-ui/client"),
  },
  "seashard.agent-settings-provider-ui/agent-settings-provider.client": {
    load: () => import("@seashard/agent-settings-provider-ui/client"),
  },
  "seashard.about-ui/about.client": {
    load: () => import("@seashard/about-ui/client"),
  },
  "seashard.game-settings-ui/game-settings.client": {
    load: () => import("@seashard/game-settings-ui/client"),
  },
  "seashard.runtime-diagnostics-ui/runtime-diagnostics.client": {
    load: () => import("@seashard/runtime-diagnostics-ui/client"),
  },
  "seashard.personalization-ui/personalization.client": {
    load: () => import("@seashard/personalization-ui/client"),
  },
  "seashard.server-download-datapack-ui/server-download-datapack.client": {
    load: () => import("@seashard/server-download-datapack-ui/client"),
  },
  "seashard.server-download-mod-ui/server-download-mod.client": {
    load: () => import("@seashard/server-download-mod-ui/client"),
  },
  "seashard.server-mods-ui/server-mods.client": {
    load: () => import("@seashard/server-mods-ui/client"),
  },
  "seashard.server-download-modpack-ui/server-download-modpack.client": {
    load: () => import("@seashard/server-download-modpack-ui/client"),
  },
  "seashard.server-download-servercore-ui/server-download-servercore.client": {
    load: () => import("@seashard/server-download-servercore-ui/client"),
  },
  "seashard.server-download-world-ui/server-download-world.client": {
    load: () => import("@seashard/server-download-world-ui/client"),
  },
  "seashard.server-configuration-ui/server-configuration.client": {
    load: () => import("@seashard/server-configuration-ui/client"),
  },
  "seashard.server-console-ui/server-console.client": {
    load: () => import("@seashard/server-console-ui/client"),
  },
  "seashard.server-instance-settings-ui/server-instance-settings.client": {
    load: () => import("@seashard/server-instance-settings-ui/client"),
  },
  "seashard.server-saves-ui/server-saves.client": {
    load: () => import("@seashard/server-saves-ui/client"),
  },
  "seashard.server-launch-ui/server-launch.client": {
    load: () => import("@seashard/server-launch-ui/client"),
  },
  "seashard.server-overview-ui/server-overview.client": {
    load: () => import("@seashard/server-overview-ui/client"),
  },
  "seashard.server-settings-ui/server-settings.client": {
    load: () => import("@seashard/server-settings-ui/client"),
  },
};
