import {
  serverCoreDownloadContract,
  serverCoreSourceContract,
  serverConfigurationContract,
  serverInstanceManagerContract,
  serverRuntimeContract,
  serverSettingsContract,
  serverModSourceContract,
} from "../packages/contracts/src/index.ts";
import { serverConfigurationUiManifest } from "../frontend/server/configuration/src/index.ts";
import { serverDownloadDatapackUiManifest } from "../frontend/server/download-datapack/src/index.ts";
import { serverDownloadModUiManifest } from "../frontend/server/download-mod/src/index.ts";
import { serverModsUiManifest } from "../frontend/server/mods/src/index.ts";
import { serverDownloadModpackUiManifest } from "../frontend/server/download-modpack/src/index.ts";
import { serverDownloadServerCoreUiManifest } from "../frontend/server/download-servercore/src/index.ts";
import { serverDownloadWorldUiManifest } from "../frontend/server/download-world/src/index.ts";
import { serverConsoleUiManifest } from "../frontend/server/console/src/index.ts";
import { serverInstanceSettingsUiManifest } from "../frontend/server/settings/src/index.ts";
import { serverLaunchUiManifest } from "../frontend/server/launch/src/index.ts";
import { serverOverviewUiManifest } from "../frontend/server/overview/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";

const components = [
  {
    manifest: serverDownloadServerCoreUiManifest,
    pluginId: "seashard.server-download-servercore-ui",
    entryId: "server-download-servercore.client",
    permissions: [serverCoreSourceContract, serverCoreDownloadContract],
  },
  {
    manifest: serverDownloadModUiManifest,
    pluginId: "seashard.server-download-mod-ui",
    entryId: "server-download-mod.client",
    permissions: [serverModSourceContract, serverInstanceManagerContract],
  },
  {
    manifest: serverModsUiManifest,
    pluginId: "seashard.server-mods-ui",
    entryId: "server-mods.client",
    permissions: [serverInstanceManagerContract, serverRuntimeContract],
  },
  {
    manifest: serverDownloadModpackUiManifest,
    pluginId: "seashard.server-download-modpack-ui",
    entryId: "server-download-modpack.client",
    permissions: [serverModSourceContract],
  },
  {
    manifest: serverDownloadDatapackUiManifest,
    pluginId: "seashard.server-download-datapack-ui",
    entryId: "server-download-datapack.client",
    permissions: [serverModSourceContract, serverInstanceManagerContract],
  },
  {
    manifest: serverDownloadWorldUiManifest,
    pluginId: "seashard.server-download-world-ui",
    entryId: "server-download-world.client",
    permissions: [serverModSourceContract, serverInstanceManagerContract],
  },
  {
    manifest: serverOverviewUiManifest,
    pluginId: "seashard.server-overview-ui",
    entryId: "server-overview.client",
    permissions: [serverInstanceManagerContract, serverRuntimeContract],
  },
  {
    manifest: serverLaunchUiManifest,
    pluginId: "seashard.server-launch-ui",
    entryId: "server-launch.client",
    permissions: [serverInstanceManagerContract, serverRuntimeContract],
  },
  {
    manifest: serverInstanceSettingsUiManifest,
    pluginId: "seashard.server-instance-settings-ui",
    entryId: "server-instance-settings.client",
    permissions: [serverInstanceManagerContract, serverRuntimeContract, serverSettingsContract],
  },
  {
    manifest: serverConsoleUiManifest,
    pluginId: "seashard.server-console-ui",
    entryId: "server-console.client",
    permissions: [serverInstanceManagerContract, serverRuntimeContract],
  },
  {
    manifest: serverConfigurationUiManifest,
    pluginId: "seashard.server-configuration-ui",
    entryId: "server-configuration.client",
    permissions: [serverInstanceManagerContract, serverConfigurationContract],
  },
] as const;

await test("server workspace pages publish independent least-privilege client components", () => {
  assert.equal(new Set(components.map(({ pluginId }) => pluginId)).size, components.length);
  assert.equal(new Set(components.map(({ entryId }) => entryId)).size, components.length);

  for (const { manifest, pluginId, entryId, permissions } of components) {
    assert.equal(manifest.id, pluginId);
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0]?.id, entryId);
    assert.equal(manifest.entries[0]?.runtime, "client");
    assert.deepEqual(manifest.entries[0]?.permissions, permissions);
  }
});
