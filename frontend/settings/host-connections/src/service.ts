import type {
  DesktopHostConnectionsClientService,
  DesktopHostConnectionsSnapshot,
} from "@seashard/contracts";

export const hostConnectionsUiServiceContract = "seashard.ui.host-connections";

/**
 * 页面消费的最小 Host 连接能力。Desktop 提供完整安装和连接操作；Server 只发布其本机
 * Controller 会话真正支持的控制权操作。
 */
export interface HostConnectionsUiService {
  getSnapshot(): Promise<DesktopHostConnectionsSnapshot>;
  onChanged(listener: (snapshot: DesktopHostConnectionsSnapshot) => void): () => void;
  install?: DesktopHostConnectionsClientService["install"];
  retry?: DesktopHostConnectionsClientService["retry"];
  disconnect?: DesktopHostConnectionsClientService["disconnect"];
  requestControl?: DesktopHostConnectionsClientService["requestControl"];
  confirmControl?: DesktopHostConnectionsClientService["confirmControl"];
  rejectControl?: DesktopHostConnectionsClientService["rejectControl"];
  releaseControl?: (hostId: string) => Promise<DesktopHostConnectionsSnapshot>;
}
