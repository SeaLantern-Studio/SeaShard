import type {
  ClientEntryPublication,
  ClientServiceCallRequest,
  ServerConsoleLine,
} from "@seashard/contracts";
import type { JsonValue, ServiceContract } from "@seashard/plugin-sdk";
import {
  projectClientEntryPublication,
  resolveClientPluginAssetPath,
  type BuiltInPackageRegistration,
  type PluginKernel,
} from "@seashard/plugin-system";
import type { DesktopHostConnections } from "./desktop-host-connections";

export class ControllerServerEventBus {
  private readonly consoleListeners = new Set<(line: ServerConsoleLine) => void>();

  publishConsoleLine(line: ServerConsoleLine): void {
    for (const listener of this.consoleListeners) listener({ ...line });
  }

  onConsoleLine(listener: (line: ServerConsoleLine) => void): () => void {
    this.consoleListeners.add(listener);
    return () => this.consoleListeners.delete(listener);
  }

  dispose(): void {
    this.consoleListeners.clear();
  }
}

/**
 * Desktop Controller 的进程边界。
 *
 * 完整 PluginKernel、全部 Client Entry 与唯一 Agent Runtime 都属于 Controller；这个类只
 * 组合 Electron Shell 所需的发布接口、Host 连接状态和服务器事件，不再合并 Host 页面或
 * 把 Agent Service 切换到 Host。
 */
export class DesktopControllerKernel {
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  constructor(
    readonly application: PluginKernel,
    readonly hosts: DesktopHostConnections,
    private readonly serverEvents: ControllerServerEventBus,
  ) {}

  get agentTools() {
    return this.application.agentTools;
  }

  get agentResources() {
    return this.application.agentResources;
  }

  get agentProviderTypes() {
    return this.application.agentProviderTypes;
  }

  registerBuiltIn(registration: BuiltInPackageRegistration) {
    return this.application.registerBuiltIn(registration);
  }

  service<TService extends object>(contract: ServiceContract<TService> | string): TService {
    return this.application.service<TService>(String(contract));
  }

  callService(
    contract: string,
    method: string,
    args: readonly JsonValue[],
  ): Promise<JsonValue | void> {
    return this.application.callService(contract, method, [...args]);
  }

  readClientEntryPublication(): ClientEntryPublication {
    return projectClientEntryPublication(this.application.clientEntrySnapshot());
  }

  onClientEntriesChanged(listener: (publication: ClientEntryPublication) => void): () => void {
    const dispose = this.application.onClientEntriesChanged((snapshot) => {
      listener(projectClientEntryPublication(snapshot));
    });
    this.disposers.push(dispose);
    return () => {
      dispose();
      const index = this.disposers.indexOf(dispose);
      if (index >= 0) this.disposers.splice(index, 1);
    };
  }

  callClientService(request: ClientServiceCallRequest): Promise<JsonValue | void> {
    return this.application.callClientService(request);
  }

  resolveClientPluginAssetPath(requestUrl: string): Promise<string | undefined> {
    return resolveClientPluginAssetPath(this.application.clientEntrySnapshot(), requestUrl);
  }

  onServerConsoleLine(listener: (line: ServerConsoleLine) => void): () => void {
    return this.serverEvents.onConsoleLine(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
    this.serverEvents.dispose();
    await this.application.dispose();
  }
}
