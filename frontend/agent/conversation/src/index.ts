import {
  agentInvocationContract,
  agentModelConfigurationContract,
  agentSessionContract,
} from "@seashard/contracts";
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
      targets: ["desktop", "web"],
      activationScopes: ["global"],
      uses: {
        [agentSessionContract]: [
          "startSession",
          "sendMessage",
          "listSessions",
          "getSession",
          "copySession",
          "deleteSession",
        ],
        [agentInvocationContract]: ["getInvocation", "cancelInvocation", "respondToInteraction"],
        [agentModelConfigurationContract]: ["getConfiguration"],
      },
      permissions: [agentSessionContract, agentInvocationContract, agentModelConfigurationContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
