import { serverModSourceContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverDownloadModpackUiManifest: PluginManifest = {
  id: "seashard.server-download-modpack-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-download-modpack.client",
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
      },
      permissions: [serverModSourceContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
