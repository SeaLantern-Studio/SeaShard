import { serverFileManagerContract, serverInstanceManagerContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverFilesUiManifest: PluginManifest = {
  id: "seashard.server-files-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-files.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop", "web"],
      activationScopes: ["global"],
      uses: {
        [serverInstanceManagerContract]: ["listForClient"],
        [serverFileManagerContract]: ["list", "readText", "writeText", "createDirectory", "delete"],
      },
      permissions: [serverInstanceManagerContract, serverFileManagerContract],
    },
  ],
  compatibility: { seaShard: ">=0.0.0 <1.0.0", clientProtocol: ">=1 <2" },
};
