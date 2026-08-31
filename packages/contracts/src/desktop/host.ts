export type DesktopHostTransport = "local" | "ssh";
export type DesktopHostInstallationState = "installed" | "missing";
export type DesktopHostConnectionState =
  | "connecting"
  | "control"
  | "read-only"
  | "disconnected"
  | "error";

export interface DesktopHostControllerIdentity {
  readonly sessionId: string;
  readonly label: string;
}

export interface DesktopHostControlRequest {
  readonly requestId: string;
  readonly requester: DesktopHostControllerIdentity;
  readonly requestedAt: string;
}

/** Controller 可展示的单个 Host 连接投影，不暴露传输令牌或本机描述文件路径。 */
export interface DesktopHostConnection {
  readonly id: string;
  readonly label: string;
  readonly transport: DesktopHostTransport;
  readonly endpoint: string;
  readonly isDefault: boolean;
  readonly state: DesktopHostConnectionState;
  readonly installation: DesktopHostInstallationState;
  readonly holder?: DesktopHostControllerIdentity;
  readonly pending?: DesktopHostControlRequest;
  readonly error?: string;
  /** 当前占用冲突已经由用户选择只读；再次出现新冲突时会重新置为 false。 */
  readonly conflictAcknowledged: boolean;
}

export interface DesktopHostConnectionsSnapshot {
  readonly revision: number;
  readonly controllerSessionId: string;
  readonly hosts: readonly DesktopHostConnection[];
}

export interface DesktopHostConnectionsClientService {
  getSnapshot(): Promise<DesktopHostConnectionsSnapshot>;
  install(hostId: string): Promise<DesktopHostConnectionsSnapshot>;
  retry(hostId: string): Promise<DesktopHostConnectionsSnapshot>;
  disconnect(hostId: string): Promise<DesktopHostConnectionsSnapshot>;
  requestControl(hostId: string): Promise<DesktopHostConnectionsSnapshot>;
  confirmControl(hostId: string, requestId: string): Promise<DesktopHostConnectionsSnapshot>;
  rejectControl(hostId: string, requestId: string): Promise<DesktopHostConnectionsSnapshot>;
  acknowledgeConflict(hostId: string): Promise<DesktopHostConnectionsSnapshot>;
  onChanged(listener: (snapshot: DesktopHostConnectionsSnapshot) => void): () => void;
}
