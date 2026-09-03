import type { ClientUiModuleLoader } from "@seashard/ui-runtime";

/** Vite 可静态追踪的内建 Server Client Entry；网页和 Desktop 使用同一模块键。 */
export const serverClientModuleLoaders: Readonly<Record<string, ClientUiModuleLoader>> = {
  "seashard.game-settings-ui/game-settings.client": {
    load: () => import("@seashard/game-settings-ui/client"),
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
};
