import type { PluginContext } from "@seashard/plugin-sdk";
import {
  createServerRuntimeLogsResource,
  createServerRuntimeResource,
} from "./agent-integration/resources";
import type { ServerRuntimeAgentRegistrationOptions } from "./agent-integration/shared";
import { registerServerRuntimeAgentTools } from "./agent-integration/tools";

/**
 * Server Runtime 的 Agent 入口只负责组装资源与工具；具体投影、校验和输出格式留在子模块。
 * 对外导出路径保持稳定，调用方不需要了解内部拆分。
 */
export function registerServerRuntimeAgentIntegration(
  context: Pick<PluginContext, "agentResources" | "agentTool">,
  options: ServerRuntimeAgentRegistrationOptions,
): void {
  context.agentResources({
    "server://instances/{instanceId}/runtime": createServerRuntimeResource(options),
    "server://instances/{instanceId}/logs": createServerRuntimeLogsResource(options),
  });
  registerServerRuntimeAgentTools(context, options);
}

export { createServerRuntimeLogsResource, createServerRuntimeResource };
export type { ServerRuntimeAgentRegistrationOptions } from "./agent-integration/shared";
