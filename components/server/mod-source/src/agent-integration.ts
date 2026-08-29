import type { PluginContext } from "@seashard/plugin-sdk";
import {
  createServerModCatalogResource,
  createServerModProjectResource,
} from "./agent-integration/catalog";
import { registerServerModInstallAgentTool } from "./agent-integration/install";
import type { ServerModCatalogAgentRegistrationOptions } from "./agent-integration/shared";

/**
 * Mod Source 组件同时拥有 Mod、数据包、世界与整合包的多来源目录。
 * 入口只负责编排当前 Mod 能力；各资源类型继续放进 agent-integration 子目录独立维护。
 */
export function registerServerModCatalogAgentIntegration(
  context: Pick<PluginContext, "agentResources" | "agentTool">,
  options: ServerModCatalogAgentRegistrationOptions,
): void {
  context.agentResources({
    "server://mods/catalog": createServerModCatalogResource(options),
    "server://mods/catalog/{source}/{projectId}": createServerModProjectResource(options),
  });
  registerServerModInstallAgentTool(context, options);
}

export * from "./agent-integration/catalog";
export * from "./agent-integration/install";
export * from "./agent-integration/shared";
