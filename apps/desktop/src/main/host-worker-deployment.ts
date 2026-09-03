import { ControllerHostWorkerDeployments } from "@seashard/controller-runtime";
import type { PluginKernel } from "@seashard/plugin-system";
import type { DesktopHostConnections } from "./desktop-host-connections";

/**
 * Desktop 只负责把 Kernel 和多 Host 连接事件接到共用部署器；包选择、同步结果解析和
 * Service 代理规则由 Controller Runtime 与 Server Controller 共用。
 */
export class HostWorkerDeploymentCoordinator {
  private stopReconciled?: () => void;
  private stopHosts?: () => void;
  private readonly deployments: ControllerHostWorkerDeployments;

  constructor(
    private readonly controller: PluginKernel,
    private readonly hosts: DesktopHostConnections,
  ) {
    this.deployments = new ControllerHostWorkerDeployments(controller, () =>
      this.hosts.clientFor("local"),
    );
  }

  start(): void {
    this.stopReconciled = this.controller.onReconciled(() => this.synchronize());
    this.stopHosts = this.hosts.onChanged(() => {
      void this.synchronize().catch((error) => {
        console.error("Host Worker synchronization failed", error);
      });
    });
  }

  dispose(): void {
    this.stopReconciled?.();
    this.stopHosts?.();
    this.stopReconciled = undefined;
    this.stopHosts = undefined;
    this.deployments.dispose();
  }

  synchronize(): Promise<void> {
    return this.deployments.synchronize();
  }
}
