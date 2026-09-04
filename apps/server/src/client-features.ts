import { aboutUiManifest } from "@seashard/about-ui";
import {
  hostConnectionsUiManifest,
  hostConnectionsUiRuntimeId,
} from "@seashard/host-connections-ui";
import { personalizationUiManifest } from "@seashard/personalization-ui";
import { pluginManagementUiRuntimeId, pluginMarketUiRuntimeId } from "@seashard/contracts";
import { pluginMarketUiManifest } from "@seashard/plugin-market-ui";
import { pluginSettingsUiManifest } from "@seashard/plugin-settings-ui";
import type { PluginKernel } from "@seashard/plugin-system";
import type { PluginManifest } from "@seashard/plugin-sdk";

interface SoftwareClientFeatureRegistration {
  readonly manifest: PluginManifest;
  readonly bindingId: string;
  readonly entryId: string;
}

const registrations: readonly SoftwareClientFeatureRegistration[] = [
  {
    manifest: pluginMarketUiManifest,
    bindingId: pluginMarketUiRuntimeId,
    entryId: "plugin-market.client",
  },
  {
    manifest: hostConnectionsUiManifest,
    bindingId: hostConnectionsUiRuntimeId,
    entryId: "host-connections.client",
  },
  {
    manifest: pluginSettingsUiManifest,
    bindingId: pluginManagementUiRuntimeId,
    entryId: "plugin-settings.client",
  },
  {
    manifest: personalizationUiManifest,
    bindingId: "core.personalization.ui",
    entryId: "personalization.client",
  },
  {
    manifest: aboutUiManifest,
    bindingId: "core.about.ui",
    entryId: "about.client",
  },
];

/** 只发布可在浏览器运行的软件设置页；Desktop 专有窗口能力仍由 Desktop 自己注册。 */
export async function registerServerSoftwareClientFeatures(kernel: PluginKernel): Promise<void> {
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
