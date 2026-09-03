import { serverInstanceManagerContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverPluginsUiManifest: PluginManifest = {
  id: "seashard.server-plugins-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-plugins.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop", "web"],
      activationScopes: ["global"],
      uses: {
        [serverInstanceManagerContract]: [
          "listForClient",
          "listPlugins",
          "setPluginDisabled",
          "deletePlugin",
        ],
      },
      permissions: [serverInstanceManagerContract],
    },
  ],
  compatibility: { seaShard: ">=0.0.0 <1.0.0", clientProtocol: ">=1 <2" },
};
