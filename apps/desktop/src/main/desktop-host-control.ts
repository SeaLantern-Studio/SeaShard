import {
  startHostControlServer,
  type HostControlServer,
  type HostServiceCall,
} from "@seashard/host-control";
import { type PluginKernel } from "@seashard/plugin-system";

const readMethodPrefixes = [
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

export interface DesktopHostControlServer {
  readonly transport: HostControlServer;
  dispose(): Promise<void>;
}

/**
 * 把本机 Kernel 提升为多 Controller Host。Transport 只接收 JSON 值，Host Kernel
 * 仅发布设备能力与 Host Worker；服务器领域 Provider 由各 Controller 持有。
 */
export async function startDesktopHostControlServer(
  kernel: PluginKernel,
  dataRoot: string,
  startedAt: string,
): Promise<DesktopHostControlServer> {
  const transport = await startHostControlServer({
    dataRoot,
    startedAt,
    handlers: {
      callService: ({ contract, method, args }) => kernel.callService(contract, method, [...args]),
      isMutation: isHostMutation,
    },
  });

  return {
    transport,
    async dispose() {
      await transport.dispose();
    },
  };
}

/**
 * 未知方法按写操作处理。内置与第三方 Service 只有命中明确读取语义时才允许旁观端调用，
 * 这样新增 API 不会因忘记登记而绕过控制权。
 */
export function isHostMutation(call: Pick<HostServiceCall, "method">): boolean {
  return !readMethodPrefixes.some(
    (prefix) => call.method === prefix || call.method.startsWith(prefix),
  );
}
