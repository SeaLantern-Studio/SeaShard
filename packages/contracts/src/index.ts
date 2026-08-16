export type RuntimePhase = "active" | "updating" | "blocked" | "failed";

export const desktopChannels = {
  runtimeSnapshot: "seashard.runtime.snapshot",
} as const;

/** 内建运行诊断组件发布的类型化 Service contract。 */
export const runtimeDiagnosticsContract = "seashard.runtime-diagnostics";

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

export interface SeaShardDesktopApi {
  runtime: {
    getSnapshot(): Promise<RuntimeSnapshot>;
  };
}
