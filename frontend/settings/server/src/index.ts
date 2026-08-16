import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverSettingsUiManifest: PluginManifest = {
  id: "seashard.server-settings-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-settings.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop"],
      activationScopes: ["global"],
      permissions: [],
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
