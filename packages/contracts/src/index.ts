import type { ActivationScope, JsonValue } from "@seashard/plugin-sdk";

export type RuntimePhase = "active" | "updating" | "blocked" | "failed";

export const desktopChannels = {
  runtimeSnapshot: "seashard.runtime.snapshot",
  clientBootstrap: "seashard.client.bootstrap",
  clientBootstrapChanged: "seashard.client.bootstrap-changed",
} as const;

/** 内建运行诊断组件发布的类型化 Service contract。 */
export const runtimeDiagnosticsContract = "seashard.runtime-diagnostics";

/** Desktop Shell 发布的主窗口生命周期 Service contract。 */
export const desktopShellContract = "seashard.desktop-shell";

/** 面向客户端的单个 runtime 投影视图。 */
export type ComponentSnapshot = {
  id: string;
  displayName: string;
  generation: number;
  phase: RuntimePhase;
  error?: string;
};

/** 可跨插件 Service 与 IPC 传输的稳定运行态读取模型。 */
export type RuntimeSnapshot = {
  protocolVersion: 1;
  host: "electron";
  state: "active" | "degraded" | "stopping";
  startedAt: string;
  components: ComponentSnapshot[];
};

/** Runtime Diagnostics Service 的消费者契约。 */
export interface RuntimeDiagnosticsService {
  getSnapshot(): Promise<RuntimeSnapshot>;
}

/** Desktop Shell Service 的宿主消费者契约。 */
export interface DesktopShellService {
  openPrimary(): Promise<void>;
}
export type ClientSurface = "primary";

/** Main 允许当前 Renderer 激活的单个 Client Entry；不暴露包目录或宿主内部对象。 */
export interface ClientEntryDescriptor {
  runtimeId: string;
  pluginId: string;
  pluginVersion: string;
  entryId: string;
  moduleKey: string;
  integrity: string;
  scopeType: ActivationScope;
  scopeId: string;
  config: JsonValue;
}

/** Client Entry 期望状态；revision 用于丢弃迟到的 Renderer 更新。 */
export interface ClientEntryPublication {
  revision: number;
  entries: readonly ClientEntryDescriptor[];
}

/** 每个 Electron WebContents 独立取得的桌面 Client 启动快照。 */
export interface DesktopClientBootstrap extends ClientEntryPublication {
  protocolVersion: 1;
  clientSession: {
    id: string;
    target: "desktop";
    surface: ClientSurface;
  };
}

export interface SeaShardDesktopApi {
  runtime: {
    getSnapshot(): Promise<RuntimeSnapshot>;
  };
  client: {
    getBootstrap(): Promise<DesktopClientBootstrap>;
    onBootstrapChanged(listener: (snapshot: DesktopClientBootstrap) => void): () => void;
  };
}
