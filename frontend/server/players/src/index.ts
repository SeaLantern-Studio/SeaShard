import { serverInstanceManagerContract, serverPlayerManagerContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverPlayersUiManifest: PluginManifest = {
  id: "seashard.server-players-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-players.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop", "web"],
      activationScopes: ["global"],
      uses: {
        [serverInstanceManagerContract]: ["list"],
        [serverPlayerManagerContract]: [
          "list",
          "setWhitelistEnabled",
          "setWhitelisted",
          "setBanned",
        ],
      },
      permissions: [serverInstanceManagerContract, serverPlayerManagerContract],
    },
  ],
  compatibility: { seaShard: ">=0.0.0 <1.0.0", clientProtocol: ">=1 <2" },
};
