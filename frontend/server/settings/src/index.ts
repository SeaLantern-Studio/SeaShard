import {
  serverInstanceManagerContract,
  serverRuntimeContract,
  serverSettingsContract,
} from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverInstanceSettingsUiManifest: PluginManifest = {
  id: "seashard.server-instance-settings-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-instance-settings.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop", "web"],
      activationScopes: ["global"],
      uses: {
        [serverInstanceManagerContract]: ["listForClient", "setStartupSettings"],
        [serverRuntimeContract]: ["preview"],
        [serverSettingsContract]: ["get"],
      },
      permissions: [serverInstanceManagerContract, serverRuntimeContract, serverSettingsContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
