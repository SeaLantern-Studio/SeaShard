import { serverInstanceManagerContract, serverRuntimeContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverOverviewUiManifest: PluginManifest = {
  id: "seashard.server-overview-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-overview.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop"],
      activationScopes: ["global"],
      permissions: [serverInstanceManagerContract, serverRuntimeContract],
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
