import { agentConversationUiManifest } from "@seashard/agent-conversation-ui";
import { agentSettingsProviderUiManifest } from "@seashard/agent-settings-provider-ui";
import { agentSettingsUiManifest } from "@seashard/agent-settings-ui";
import type { PluginManifest } from "@seashard/plugin-sdk";
import type { PluginKernel } from "@seashard/plugin-system";

interface AgentClientFeatureRegistration {
  readonly manifest: PluginManifest;
  readonly bindingId: string;
  readonly entryId: string;
}

const registrations: readonly AgentClientFeatureRegistration[] = [
  {
    manifest: agentConversationUiManifest,
    bindingId: "core.agent-conversation.ui",
    entryId: "agent-conversation.client",
  },
  {
    manifest: agentSettingsUiManifest,
    bindingId: "core.agent-settings.ui",
    entryId: "agent-settings.client",
  },
  {
    manifest: agentSettingsProviderUiManifest,
    bindingId: "core.agent-settings-provider.ui",
    entryId: "agent-settings-provider.client",
  },
];

/** Desktop 与 Server Controller 使用完全相同的 Agent 页面和固定 Binding 身份。 */
export async function registerAgentClientFeatures(kernel: PluginKernel): Promise<void> {
  for (const registration of registrations) {
    await kernel.registerBuiltIn({
      manifest: registration.manifest,
      loaders: {},
      bindings: [
        {
          id: registration.bindingId,
          entryId: registration.entryId,
          scopeType: "global",
          scopeId: "global",
          enabled: true,
          config: null,
        },
      ],
    });
  }
}
