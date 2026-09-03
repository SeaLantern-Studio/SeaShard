import type { PluginManifest } from "@seashard/plugin-sdk";
import type { PluginKernel } from "@seashard/plugin-system";
import { gameSettingsUiManifest } from "@seashard/game-settings-ui";
import { serverConfigurationUiManifest } from "@seashard/server-configuration-ui";
import { serverConsoleUiManifest } from "@seashard/server-console-ui";
import { serverDownloadDatapackUiManifest } from "@seashard/server-download-datapack-ui";
import { serverDownloadModUiManifest } from "@seashard/server-download-mod-ui";
import { serverDownloadModpackUiManifest } from "@seashard/server-download-modpack-ui";
import { serverDownloadServerCoreUiManifest } from "@seashard/server-download-servercore-ui";
import { serverDownloadWorldUiManifest } from "@seashard/server-download-world-ui";
import { serverFilesUiManifest } from "@seashard/server-files-ui";
import { serverInstanceSettingsUiManifest } from "@seashard/server-instance-settings-ui";
import { serverLaunchUiManifest } from "@seashard/server-launch-ui";
import { serverModsUiManifest } from "@seashard/server-mods-ui";
import { serverPlayersUiManifest } from "@seashard/server-players-ui";
import { serverPluginsUiManifest } from "@seashard/server-plugins-ui";
import { serverOverviewUiManifest } from "@seashard/server-overview-ui";
import { serverSavesUiManifest } from "@seashard/server-saves-ui";
import { serverSettingsUiManifest } from "@seashard/server-settings-ui";

interface ServerClientFeatureRegistration {
  readonly manifest: PluginManifest;
  readonly bindingId: string;
  readonly entryId: string;
}

const registrations: readonly ServerClientFeatureRegistration[] = [
  {
    manifest: gameSettingsUiManifest,
    bindingId: "core.game-settings.ui",
    entryId: "game-settings.client",
  },
  {
    manifest: serverDownloadServerCoreUiManifest,
    bindingId: "core.server-download-servercore.ui",
    entryId: "server-download-servercore.client",
  },
  {
    manifest: serverDownloadModUiManifest,
    bindingId: "core.server-download-mod.ui",
    entryId: "server-download-mod.client",
  },
  {
    manifest: serverDownloadModpackUiManifest,
    bindingId: "core.server-download-modpack.ui",
    entryId: "server-download-modpack.client",
  },
  {
    manifest: serverDownloadDatapackUiManifest,
    bindingId: "core.server-download-datapack.ui",
    entryId: "server-download-datapack.client",
  },
  {
    manifest: serverDownloadWorldUiManifest,
    bindingId: "core.server-download-world.ui",
    entryId: "server-download-world.client",
  },
  {
    manifest: serverFilesUiManifest,
    bindingId: "core.server-files.ui",
    entryId: "server-files.client",
  },
  {
    manifest: serverOverviewUiManifest,
    bindingId: "core.server-overview.ui",
    entryId: "server-overview.client",
  },
  {
    manifest: serverSavesUiManifest,
    bindingId: "core.server-saves.ui",
    entryId: "server-saves.client",
  },
  {
    manifest: serverModsUiManifest,
    bindingId: "core.server-mods.ui",
    entryId: "server-mods.client",
  },
  {
    manifest: serverPlayersUiManifest,
    bindingId: "core.server-players.ui",
    entryId: "server-players.client",
  },
  {
    manifest: serverPluginsUiManifest,
    bindingId: "core.server-plugins.ui",
    entryId: "server-plugins.client",
  },
  {
    manifest: serverLaunchUiManifest,
    bindingId: "core.server-launch.ui",
    entryId: "server-launch.client",
  },
  {
    manifest: serverInstanceSettingsUiManifest,
    bindingId: "core.server-instance-settings.ui",
    entryId: "server-instance-settings.client",
  },
  {
    manifest: serverSettingsUiManifest,
    bindingId: "core.server-settings.ui",
    entryId: "server-settings.client",
  },
  {
    manifest: serverConsoleUiManifest,
    bindingId: "core.server-console.ui",
    entryId: "server-console.client",
  },
  {
    manifest: serverConfigurationUiManifest,
    bindingId: "core.server-configuration.ui",
    entryId: "server-configuration.client",
  },
];

/** Desktop 和 Server Controller 共同注册服务器页面；Kernel 按 clientTarget 选择目标 Entry。 */
export async function registerServerClientFeatures(kernel: PluginKernel): Promise<void> {
  for (const registration of registrations) {
    await kernel.registerBuiltIn({
      manifest: registration.manifest,
      loaders: {},
      bindings: [
        {
          id: registration.bindingId,
          entryId: registration.entryId,
          scopeType: "global",
          scopeId: "global",
          enabled: true,
          config: null,
        },
      ],
    });
  }
}
