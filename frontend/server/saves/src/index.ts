import { serverInstanceManagerContract, serverRuntimeContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverSavesUiManifest: PluginManifest = {
  id: "seashard.server-saves-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-saves.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop"],
      activationScopes: ["global"],
      permissions: [serverInstanceManagerContract, serverRuntimeContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
