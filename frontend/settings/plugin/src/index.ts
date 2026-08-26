import { pluginManagementContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const pluginSettingsUiManifest: PluginManifest = {
  id: "seashard.plugin-settings-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "plugin-settings.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop"],
      activationScopes: ["global"],
      uses: {
        [pluginManagementContract]: ["list", "setEnabled", "uninstall"],
      },
      permissions: [pluginManagementContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
