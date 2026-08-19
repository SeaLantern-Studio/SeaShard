import {
  serverConfigurationContract,
  serverInstanceManagerContract,
  serverRuntimeContract,
} from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverLaunchUiManifest: PluginManifest = {
  id: "seashard.server-launch-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-launch.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop"],
      activationScopes: ["global"],
      permissions: [
        serverInstanceManagerContract,
        serverRuntimeContract,
        serverConfigurationContract,
      ],
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
