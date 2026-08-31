import {
  runtimeDiagnosticsContract,
  type ComponentSnapshot,
  type RuntimeSnapshot,
} from "@seashard/contracts";
import type { PluginManifest, PluginModule, RuntimeControlSnapshot } from "@seashard/plugin-sdk";

/** 运行态投影只读取 Cordis 当前插件快照和宿主状态。 */
export interface RuntimeProjectionOptions {
  readonly host: RuntimeSnapshot["host"];
  readonly startedAt: string;
  readonly stopping: boolean;
}

export interface RuntimeDiagnosticsConfig {
  readonly host: RuntimeSnapshot["host"];
  readonly startedAt: string;
  readControlSnapshot(): RuntimeControlSnapshot;
  isStopping(): boolean;
}

export const runtimeDiagnosticsManifest: PluginManifest = {
  id: "seashard.runtime-diagnostics",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "runtime-diagnostics.host",
      runtime: "host",
      execution: "controller",
      module: "./dist/host.js",
      hostProfiles: ["electron", "node", "docker"],
      activationScopes: ["global"],
      permissions: [],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/** 创建向 Desktop Shell 提供稳定诊断视图的内建组件。 */
export function createRuntimeDiagnosticsModule(config: RuntimeDiagnosticsConfig): PluginModule {
  return {
    provides: [runtimeDiagnosticsContract],
    apply(ctx) {
      ctx.provide(runtimeDiagnosticsContract, {
        getSnapshot: () =>
          projectRuntimeSnapshot(config.readControlSnapshot(), {
            host: config.host,
            startedAt: config.startedAt,
            stopping: config.isStopping(),
          }),
      });
    },
  };
}

/** 将 Cordis 插件快照转换成跨 IPC 的只读诊断视图。 */
export function projectRuntimeSnapshot(
  control: RuntimeControlSnapshot,
  options: RuntimeProjectionOptions,
): RuntimeSnapshot {
  const components: ComponentSnapshot[] = control.plugins
    .map((plugin) => ({
      id: plugin.runtimeId,
      displayName: `${plugin.pluginId}/${plugin.entryId}`,
      phase: plugin.state,
      ...(plugin.error ? { error: plugin.error } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    protocolVersion: 1,
    host: options.host,
    state: options.stopping
      ? "stopping"
      : components.some((component) => component.phase === "failed")
        ? "degraded"
        : "active",
    startedAt: options.startedAt,
    components,
  };
}
