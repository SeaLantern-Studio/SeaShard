import { serverInstanceManagerContract, serverModSourceContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverDownloadModUiManifest: PluginManifest = {
  id: "seashard.server-download-mod-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-download-mod.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop"],
      activationScopes: ["global"],
      permissions: [serverModSourceContract, serverInstanceManagerContract],
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
