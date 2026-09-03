import { serverInstanceManagerContract, serverModSourceContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverDownloadWorldUiManifest: PluginManifest = {
  id: "seashard.server-download-world-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-download-world.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop", "web"],
      activationScopes: ["global"],
      uses: {
        [serverModSourceContract]: [
          "getFilters",
          "search",
          "getProjectDetails",
          "installToInstance",
          "saveAs",
        ],
        [serverInstanceManagerContract]: ["list"],
      },
      permissions: [serverModSourceContract, serverInstanceManagerContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
