import type {
  DesktopHostConnection,
  DesktopHostConnectionsSnapshot,
  DesktopHostInstallationState,
} from "@seashard/contracts";
import type {
  HostControlClient,
  HostControlEventName,
  HostControlSnapshot,
} from "@seashard/host-control";
import type { JsonValue } from "@seashard/plugin-sdk";

const localHostId = "local";
type HostEventListener = (hostId: string, payload: JsonValue) => void;
export type LocalHostInstallDisposition = "installed" | "external";

export interface DesktopHostConnectionsOptions {
  readonly controllerSessionId: string;
  readonly initialInstallation: DesktopHostInstallationState;
  readonly initialClient?: HostControlClient;
  readonly initialError?: string;
  connectLocal(): Promise<HostControlClient>;
  readLocalInstallation(): Promise<DesktopHostInstallationState>;
  installLocal(): Promise<LocalHostInstallDisposition>;
}

/**
 * Controller 级 Host 连接状态源。当前先接入本机 Host，公开投影从第一天就是 Host 数组，
 * 后续增加 SSH 传输时无需重写 Header、右侧栏和设置页的状态结构。
 */
export class DesktopHostConnections {
  private readonly snapshotListeners = new Set<
    (snapshot: DesktopHostConnectionsSnapshot) => void
  >();
  private readonly clientListeners = new Set<(client: HostControlClient | undefined) => void>();
  private readonly hostEventListeners = new Map<HostControlEventName, Set<HostEventListener>>();
  private readonly hostEventDisposers = new Map<HostControlEventName, () => void>();
  private revision = 0;
  private clientValue: HostControlClient | undefined;
  private stopControlEvents: (() => void) | undefined;
  private stopClientClosed: (() => void) | undefined;
  private connecting = false;
  private installation: DesktopHostInstallationState;
  private error: string | undefined;
  private conflictAcknowledged = false;
  private disposed = false;

  constructor(private readonly options: DesktopHostConnectionsOptions) {
    this.installation = options.initialInstallation;
    this.error = options.initialError;
    if (options.initialClient) this.attach(options.initialClient);
  }

  get client(): HostControlClient | undefined {
    return this.clientValue;
  }

  /** Controller 基础设施按 Host 身份取得连接；普通实例调用不直接使用该接口。 */
  clientFor(hostId: string): HostControlClient | undefined {
    return hostId === localHostId ? this.clientValue : undefined;
  }

  /** 为实例目录聚合与简写 ID 解析提供当前已连接的 Host 集合。 */
  connectedClients(): readonly { readonly hostId: string; readonly client: HostControlClient }[] {
    return this.clientValue ? [{ hostId: localHostId, client: this.clientValue }] : [];
  }

  /** 离线 Host 仍保留拓扑身份，使完整实例 ID 可以返回准确的不可用错误。 */
  knownHostIds(): readonly string[] {
    return this.getSnapshot().hosts.map(({ id }) => id);
  }

  getSnapshot(): DesktopHostConnectionsSnapshot {
    return {
      revision: this.revision,
      controllerSessionId: this.options.controllerSessionId,
      hosts: [this.projectLocalHost()],
    };
  }

  onChanged(listener: (snapshot: DesktopHostConnectionsSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  onClientChanged(listener: (client: HostControlClient | undefined) => void): () => void {
    this.clientListeners.add(listener);
    return () => this.clientListeners.delete(listener);
  }

  onHostEvent(event: HostControlEventName, listener: HostEventListener): () => void {
    const listeners = this.hostEventListeners.get(event) ?? new Set<HostEventListener>();
    listeners.add(listener);
    this.hostEventListeners.set(event, listeners);
    this.bindHostEvent(event);
    return () => {
      listeners.delete(listener);
      if (listeners.size > 0) return;
      this.hostEventListeners.delete(event);
      this.hostEventDisposers.get(event)?.();
      this.hostEventDisposers.delete(event);
    };
  }

  async install(hostId: string): Promise<DesktopHostConnectionsSnapshot> {
    this.assertLocalHost(hostId);
    try {
      const disposition = await this.options.installLocal();
      if (disposition === "installed") {
        // 内置安装器等待 Host 发布控制端点；随后在同一次用户操作中刷新事实并建立连接。
        return this.retry(hostId);
      }
      // 外部安装器由用户接管后暂时关闭提示；安装完成后通过“重新连接”刷新安装事实。
      this.conflictAcknowledged = true;
      this.publish();
      return this.getSnapshot();
    } catch (error) {
      // 首次启动发生在 Renderer 建立前，必须把安装错误留在 Host 状态中供页面稍后展示。
      this.error = formatError(error);
      this.publish();
      throw error;
    }
  }

  async retry(hostId: string): Promise<DesktopHostConnectionsSnapshot> {
    this.assertLocalHost(hostId);
    if (this.clientValue) return this.getSnapshot();
    this.connecting = true;
    this.error = undefined;
    this.publish();
    try {
      this.installation = await this.options.readLocalInstallation();
      const client = await this.options.connectLocal();
      if (this.disposed) {
        client.dispose();
        throw new Error("Desktop Host connections were disposed");
      }
      this.attach(client);
    } catch (error) {
      this.error = formatError(error);
      throw error;
    } finally {
      this.connecting = false;
      this.publish();
    }
    return this.getSnapshot();
  }

  async disconnect(hostId: string): Promise<DesktopHostConnectionsSnapshot> {
    this.assertLocalHost(hostId);
    this.detach(true);
    this.error = undefined;
    this.conflictAcknowledged = false;
    this.publish();
    return this.getSnapshot();
  }

  async requestControl(hostId: string): Promise<DesktopHostConnectionsSnapshot> {
    const client = this.requireClient(hostId);
    await client.requestControl();
    this.conflictAcknowledged = false;
    this.publish();
    return this.getSnapshot();
  }

  async confirmControl(hostId: string, requestId: string): Promise<DesktopHostConnectionsSnapshot> {
    const client = this.requireClient(hostId);
    await client.confirmControl(requestId);
    this.conflictAcknowledged = client.hasControl;
    this.publish();
    return this.getSnapshot();
  }

  async rejectControl(hostId: string, requestId: string): Promise<DesktopHostConnectionsSnapshot> {
    const client = this.requireClient(hostId);
    await client.rejectControl(requestId);
    this.conflictAcknowledged = !client.hasControl;
    this.publish();
    return this.getSnapshot();
  }

  acknowledgeConflict(hostId: string): DesktopHostConnectionsSnapshot {
    this.assertLocalHost(hostId);
    this.conflictAcknowledged = true;
    this.publish();
    return this.getSnapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach(true);
    this.snapshotListeners.clear();
    this.clientListeners.clear();
    this.hostEventListeners.clear();
  }

  private attach(client: HostControlClient): void {
    this.detach(true);
    this.installation = "installed";
    this.clientValue = client;
    this.error = undefined;
    this.conflictAcknowledged = client.hasControl;
    this.stopControlEvents = client.on("control-snapshot", () => {
      const snapshot = client.controlSnapshot;
      if (snapshot.holder?.sessionId === this.options.controllerSessionId) {
        this.conflictAcknowledged = true;
      }
      if (snapshot.pending) this.conflictAcknowledged = false;
      this.publish();
    });
    this.stopClientClosed = client.onClosed((error) => {
      if (this.clientValue !== client) return;
      this.detach(false);
      this.error = error?.message ?? "Host 连接已断开";
      this.conflictAcknowledged = false;
      this.publish();
    });
    this.rebindHostEvents();
    this.publishClient();
    this.publish();
  }

  private detach(disposeClient: boolean): void {
    const client = this.clientValue;
    this.stopControlEvents?.();
    this.stopControlEvents = undefined;
    this.stopClientClosed?.();
    this.stopClientClosed = undefined;
    for (const dispose of this.hostEventDisposers.values()) dispose();
    this.hostEventDisposers.clear();
    this.clientValue = undefined;
    if (disposeClient) client?.dispose();
    if (client) this.publishClient();
  }

  private bindHostEvent(event: HostControlEventName): void {
    this.hostEventDisposers.get(event)?.();
    this.hostEventDisposers.delete(event);
    const client = this.clientValue;
    const listeners = this.hostEventListeners.get(event);
    if (!client || !listeners?.size) return;
    this.hostEventDisposers.set(
      event,
      client.on(event, (payload) => {
        for (const listener of listeners) listener(localHostId, payload);
      }),
    );
  }

  private rebindHostEvents(): void {
    for (const event of this.hostEventListeners.keys()) this.bindHostEvent(event);
  }

  private projectLocalHost(): DesktopHostConnection {
    const client = this.clientValue;
    const control = client?.controlSnapshot;
    return {
      id: localHostId,
      label: "本机 Host",
      transport: "local",
      endpoint: "当前设备",
      isDefault: true,
      installation: this.installation,
      state: this.connecting
        ? "connecting"
        : client
          ? client.hasControl
            ? "control"
            : "read-only"
          : this.error
            ? "error"
            : "disconnected",
      ...(control?.holder
        ? {
            holder: {
              sessionId: control.holder.sessionId,
              label: control.holder.label,
            },
          }
        : {}),
      ...(control?.pending ? { pending: projectRequest(control) } : {}),
      ...(this.error ? { error: this.error } : {}),
      conflictAcknowledged: this.conflictAcknowledged,
    };
  }

  private publish(): void {
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of this.snapshotListeners) listener(snapshot);
  }

  private publishClient(): void {
    for (const listener of this.clientListeners) listener(this.clientValue);
  }

  private requireClient(hostId: string): HostControlClient {
    this.assertLocalHost(hostId);
    if (!this.clientValue) throw new Error("本机 Host 当前未连接");
    return this.clientValue;
  }

  private assertLocalHost(hostId: string): void {
    if (hostId !== localHostId) throw new Error(`未知 Host：${hostId}`);
  }
}

function projectRequest(control: HostControlSnapshot) {
  const pending = control.pending;
  if (!pending) return undefined;
  return {
    requestId: pending.requestId,
    requester: {
      sessionId: pending.requester.sessionId,
      label: pending.requester.label,
    },
    requestedAt: pending.requestedAt,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
