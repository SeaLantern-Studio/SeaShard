import { agentSettingsContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const agentSettingsUiManifest: PluginManifest = {
  id: "seashard.agent-settings-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "agent-settings.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop", "web"],
      activationScopes: ["global"],
      uses: {
        [agentSettingsContract]: ["get", "setAutomaticConversationSummary"],
      },
      permissions: [agentSettingsContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
