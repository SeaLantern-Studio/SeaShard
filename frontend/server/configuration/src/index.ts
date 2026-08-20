import { serverConfigurationContract, serverInstanceManagerContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverConfigurationUiManifest: PluginManifest = {
  id: "seashard.server-configuration-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-configuration.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop"],
      activationScopes: ["global"],
      permissions: [serverInstanceManagerContract, serverConfigurationContract],
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
