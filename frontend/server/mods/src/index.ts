import { serverInstanceManagerContract, serverRuntimeContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverModsUiManifest: PluginManifest = {
  id: "seashard.server-mods-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-mods.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop", "web"],
      activationScopes: ["global"],
      uses: {
        [serverInstanceManagerContract]: [
          "listForClient",
          "listMods",
          "setModDisabled",
          "deleteMod",
        ],
        [serverRuntimeContract]: ["get"],
      },
      permissions: [serverInstanceManagerContract, serverRuntimeContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
