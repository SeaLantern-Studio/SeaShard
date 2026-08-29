import type { PluginContext } from "@seashard/plugin-sdk";
import {
  createServerModCatalogResource,
  createServerModProjectResource,
} from "./agent-integration/catalog";
import {
  createServerDatapackCatalogResource,
  createServerDatapackProjectResource,
} from "./agent-integration/datapack-catalog";
import { registerServerDatapackInstallAgentTool } from "./agent-integration/datapack-install";
import { registerServerModInstallAgentTool } from "./agent-integration/install";
import type {
  ServerDatapackCatalogAgentRegistrationOptions,
  ServerModCatalogAgentRegistrationOptions,
} from "./agent-integration/shared";

/** 当前入口编排 Mod 资源；多来源目录的通用分页和安全投影位于独立共享适配器。 */
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

/** 数据包目录与安装保持独立 URI 和工具身份，底层继续复用 Mod Source 目录与下载事务。 */
export function registerServerDatapackCatalogAgentIntegration(
  context: Pick<PluginContext, "agentResources" | "agentTool">,
  options: ServerDatapackCatalogAgentRegistrationOptions,
): void {
  context.agentResources({
    "server://datapacks/catalog": createServerDatapackCatalogResource(options),
    "server://datapacks/catalog/{source}/{projectId}": createServerDatapackProjectResource(options),
  });
  registerServerDatapackInstallAgentTool(context, options);
}

export * from "./agent-integration/catalog";
export * from "./agent-integration/datapack-catalog";
export * from "./agent-integration/datapack-install";
export * from "./agent-integration/install";
export * from "./agent-integration/resource-catalog";
export * from "./agent-integration/shared";
