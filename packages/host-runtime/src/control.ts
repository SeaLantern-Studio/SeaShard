import {
  startHostControlServer,
  type HostControlServer,
  type HostServiceCall,
} from "@seashard/host-control";
import type { PluginKernel } from "@seashard/plugin-system";

const readMethodPrefixes = [
  "describe",
  "get",
  "list",
  "read",
  "search",
  "resolve",
  "inspect",
  "preview",
  "discover",
  "scan",
  "snapshot",
  "contentCounts",
  "waitUntil",
] as const;

/**
 * 把 Host Kernel 暴露给本机 Controller。Transport 只承载 JSON，设备能力与
 * Host Worker 的实际生命周期仍由同一个 Host Kernel 管理。
 */
export function startHostRuntimeControlServer(
  kernel: PluginKernel,
  dataRoot: string,
  startedAt: string,
  seaShardVersion: string,
  packageType?: HostControlServer["descriptor"]["packageType"],
): Promise<HostControlServer> {
  return startHostControlServer({
    dataRoot,
    startedAt,
    seaShardVersion,
    packageType,
    handlers: {
      describeServices: () =>
        kernel.services.snapshot().map(({ contract, methods }) => ({ contract, methods })),
      callService: ({ contract, method, args }) => kernel.callService(contract, method, [...args]),
      isMutation: isHostMutation,
      describeAgentExtensions: () => {
        const resources = kernel.agentResources.snapshot();
        return {
          tools: kernel.agentTools.snapshot().map(({ name, definition }) => ({
            name,
            definition,
          })),
          resources: resources.definitions,
        };
      },
      isAgentToolMutation: (name) => {
        const tool = kernel.agentTools.snapshot().find((candidate) => candidate.name === name);
        return !tool || (tool.definition.confirmationLevel ?? 0) > 0;
      },
      executeAgentTool: async ({ name, input }) => {
        const tool = kernel.agentTools.snapshot().find((candidate) => candidate.name === name);
        if (!tool) throw new Error(`Host Agent 工具不存在：${name}`);
        return tool.execute(input, {});
      },
      readAgentResource: ({ path, input }) =>
        kernel.agentResources.snapshot().read(path, input, {}),
      presentAgentResourceRequest: async ({ path, input }) =>
        kernel.agentResources.snapshot().prepare(path, input).presentRequest(),
      presentAgentResourceResult: async ({ path, input, result }) =>
        kernel.agentResources.snapshot().prepare(path, input).presentResult(result),
    },
  });
}

/**
 * 未知方法按写操作处理。只有明确读取语义允许旁观 Controller 调用，避免第三方
 * Service 新增方法时因遗漏声明而绕过 Host 的唯一写控制权。
 */
export function isHostMutation(call: Pick<HostServiceCall, "method">): boolean {
  return !readMethodPrefixes.some(
    (prefix) => call.method === prefix || call.method.startsWith(prefix),
  );
}
