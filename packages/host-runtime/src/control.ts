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
      callService: ({ contract, method, args }) => kernel.callService(contract, method, [...args]),
      isMutation: isHostMutation,
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
