import { agentModelConfigurationContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const agentSettingsProviderUiManifest: PluginManifest = {
  id: "seashard.agent-settings-provider-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "agent-settings-provider.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop", "web"],
      activationScopes: ["global"],
      uses: {
        [agentModelConfigurationContract]: [
          "getConfiguration",
          "mutateConnection",
          "removeConnection",
          "resetConfiguration",
          "discoverModels",
          "writeCredential",
          "removeCredential",
          "openConfigurationFile",
        ],
      },
      permissions: [agentModelConfigurationContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
