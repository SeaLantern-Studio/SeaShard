import type { PluginContext } from "@seashard/plugin-sdk";
import { registerServerDownloadConnectionsAgentTool } from "./agent-integration/download-connections";
import { createServerSettingsResource } from "./agent-integration/resources";
import type { ServerSettingsAgentRegistrationOptions } from "./agent-integration/shared";
import { registerServerStartupDefaultsAgentTool } from "./agent-integration/startup-defaults";

/**
 * Server Settings 的 Agent 入口只组装资源和独立设置域工具。
 * 新设置域只需在此完成组装，具体实现继续留在独立子模块。
 */
export function registerServerSettingsAgentIntegration(
  context: Pick<PluginContext, "agentResources" | "agentTool">,
  options: ServerSettingsAgentRegistrationOptions,
): void {
  context.agentResources({
    "server://settings": createServerSettingsResource(options),
  });
  registerServerDownloadConnectionsAgentTool(context, options);
  registerServerStartupDefaultsAgentTool(context, options);
}

export { createServerSettingsResource };
export type {
  ServerSettingsAgentMutationReceipt,
  ServerSettingsAgentRegistrationOptions,
  ServerSettingsAgentStartupDefaultsPatch,
} from "./agent-integration/shared";
