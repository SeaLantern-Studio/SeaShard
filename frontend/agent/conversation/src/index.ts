import { agentInvocationContract, agentSessionContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const agentConversationUiManifest: PluginManifest = {
  id: "seashard.agent-conversation-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "agent-conversation.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop"],
      activationScopes: ["global"],
      permissions: [agentSessionContract, agentInvocationContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
