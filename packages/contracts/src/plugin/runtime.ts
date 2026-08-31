import { defineServiceContract } from "@seashard/plugin-sdk";
import type { RuntimePhase } from "../shared.js";

/** 内建运行诊断组件发布的类型化 Service contract。 */
export const runtimeDiagnosticsContract = defineServiceContract<RuntimeDiagnosticsService>(
  "seashard.runtime-diagnostics",
);
/** 面向客户端的单个插件运行视图。 */
export type ComponentSnapshot = {
  id: string;
  displayName: string;
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
/** 读取普通插件运行状态的稳定诊断投影。 */
export interface RuntimeDiagnosticsService {
  /**
   * 读取当前 Host 和全部普通组件的运行状态。
   *
   * @returns 不暴露 Cordis 或宿主句柄的运行态快照。
   */
  getSnapshot(): Promise<RuntimeSnapshot>;
}
