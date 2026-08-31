import { hostLifecycleContract } from "@seashard/host-control";
import type { PluginKernel } from "@seashard/plugin-system";

/**
 * Host 只接受持有写控制权的维护停机调用。实际进程退出由外层可执行程序负责；短暂
 * 延迟让当前 RPC 响应先写回 Controller，再关闭控制端口和插件进程。
 */
export function registerHostLifecycleService(
  kernel: PluginKernel,
  requestShutdown: (() => void) | undefined,
): void {
  kernel.registerCoreService(hostLifecycleContract, {
    shutdown() {
      if (!requestShutdown) throw new Error("Host process shutdown is not available");
      setTimeout(requestShutdown, 50).unref();
    },
  });
}
