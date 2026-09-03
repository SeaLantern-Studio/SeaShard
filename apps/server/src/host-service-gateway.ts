import type { JsonValue, ServiceProvider } from "@seashard/plugin-sdk";
import type { PluginKernel } from "@seashard/plugin-system";
import type { ServerLocalHostConnection } from "./local-host";

const internalContractPrefix = "seashard.internal.";
const serviceMethodPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/**
 * 把 Host 实际发布的服务目录投影进 Server Controller Kernel。
 * Client Entry 仍通过 Kernel 发起调用，因此 Manifest permissions 与运行身份校验不会被 HTTP 绕过。
 */
export class ServerHostServiceGateway {
  private readonly disposers: Array<() => void> = [];

  private constructor(
    private readonly kernel: PluginKernel,
    private readonly host: ServerLocalHostConnection,
  ) {}

  static async register(
    kernel: PluginKernel,
    host: ServerLocalHostConnection,
  ): Promise<ServerHostServiceGateway> {
    const gateway = new ServerHostServiceGateway(kernel, host);
    try {
      await gateway.registerCurrentServices();
      return gateway;
    } catch (error) {
      gateway.dispose();
      throw error;
    }
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
  }

  private async registerCurrentServices(): Promise<void> {
    const descriptors = await this.host.describeServices();
    for (const descriptor of descriptors) {
      if (descriptor.contract.startsWith(internalContractPrefix)) continue;
      if (this.kernel.services.has(descriptor.contract)) continue;
      const entries: Array<[string, ServiceProvider[string]]> = [];
      for (const method of descriptor.methods) {
        if (!serviceMethodPattern.test(method)) {
          throw new TypeError(`Host Service 方法名无效：${descriptor.contract}.${method}`);
        }
        entries.push([
          method,
          (...args: JsonValue[]) => this.host.callService(descriptor.contract, method, args),
        ]);
      }
      if (entries.length === 0) continue;
      const provider: ServiceProvider = Object.fromEntries(entries);
      this.disposers.push(this.kernel.registerCoreService(descriptor.contract, provider));
    }
  }
}
