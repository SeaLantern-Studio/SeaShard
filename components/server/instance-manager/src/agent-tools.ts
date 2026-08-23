import type { ServerInstanceSnapshot } from "@seashard/contracts";
import type { AgentToolDefinition, JsonObject, PluginContext } from "@seashard/plugin-sdk";

export interface ServerInstanceAgentToolOptions {
  listInstances(): Promise<readonly ServerInstanceSnapshot[]>;
}

const serverListToolDefinition: AgentToolDefinition = {
  namespace: "server",
  name: "list",
  title: "读取服务器列表",
  description:
    "读取 SeaShard 已登记的服务器实例。用于回答服务器名称、核心类型、Minecraft 版本、存储方式、来源和最近启动时间；结果不包含宿主文件路径。",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  outputDescription: "返回按更新时间排序的服务器实例摘要，不包含宿主绝对路径。",
};

/**
 * 实例组件在自己的 Fiber 中声明 Agent 能力；Plugin Kernel 负责运行时身份与自动注销。
 */
export function registerServerInstanceAgentTools(
  context: Pick<PluginContext, "agentTool">,
  options: ServerInstanceAgentToolOptions,
): string {
  return context.agentTool(serverListToolDefinition, async () =>
    (await options.listInstances()).map(projectServerForAgent),
  );
}

/** 工具输出只保留回答问题需要的字段，绝不把宿主绝对路径交给模型。 */
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
