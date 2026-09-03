import { javaRuntimeManagerContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const gameSettingsUiManifest: PluginManifest = {
  id: "seashard.game-settings-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "game-settings.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop", "web"],
      activationScopes: ["global"],
      uses: {
        [javaRuntimeManagerContract]: ["scan", "remove", "setDisabled"],
      },
      permissions: [javaRuntimeManagerContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
