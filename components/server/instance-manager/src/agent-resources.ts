import type { ServerInstanceSnapshot } from "@seashard/contracts";
import type { AgentResourceDefinition, JsonObject, PluginContext } from "@seashard/plugin-sdk";

export interface ServerInstanceAgentResourceOptions {
  listInstances(): Promise<readonly ServerInstanceSnapshot[]>;
}

const serverInstancesResourceDefinition: AgentResourceDefinition = {
  pattern: "server://instances",
  description:
    "读取 SeaShard 已登记的服务器实例，包括名称、核心类型、Minecraft 版本、存储方式、来源和最近启动时间；结果不包含宿主文件路径。",
};

/**
 * 实例组件在自己的 Fiber 中声明只读资源；Plugin Kernel 负责路由和自动注销。
 */
export function registerServerInstanceAgentResources(
  context: Pick<PluginContext, "agentResource">,
  options: ServerInstanceAgentResourceOptions,
): string {
  return context.agentResource(serverInstancesResourceDefinition, async () => ({
    mimeType: "application/json",
    content: JSON.stringify((await options.listInstances()).map(projectServerForAgent), null, 2),
  }));
}

/** 资源内容只保留回答问题需要的字段，绝不把宿主绝对路径交给模型。 */
function projectServerForAgent(instance: ServerInstanceSnapshot): JsonObject {
  const projected: JsonObject = {
    id: instance.id,
    name: instance.name,
    storageMode: instance.storageMode,
    source: instance.source,
    modLoader: instance.modLoader,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
  if (instance.serverType) projected.serverType = instance.serverType;
  if (instance.gameVersion) projected.gameVersion = instance.gameVersion;
  if (instance.lastStartedAt) projected.lastStartedAt = instance.lastStartedAt;
  return projected;
}
