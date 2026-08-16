import {
  desktopChannels,
  runtimeDiagnosticsContract,
  type RuntimeDiagnosticsService,
  type RuntimeSnapshot,
} from "@seashard/contracts";
import type { PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import { ipcMain, type IpcMainInvokeEvent } from "electron";

export interface DesktopGatewayConfig {
  authorize(event: IpcMainInvokeEvent): boolean;
  onRuntimeSnapshotServed?(snapshot: RuntimeSnapshot): void;
}

export const desktopGatewayManifest: PluginManifest = {
  id: "seashard.desktop-gateway",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "desktop-gateway.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron"],
      activationScopes: ["global"],
      permissions: [runtimeDiagnosticsContract],
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/**
 * 创建只负责 Electron IPC 传输和窗口授权的 Desktop Gateway。
 *
 * Generation/Publication/Operation 的解释规则属于 Runtime Diagnostics Component；
 * Gateway 通过类型化 Service 获取最终快照，不再持有任何投影策略。
 */
export function createDesktopGatewayModule(config: DesktopGatewayConfig): PluginModule {
  return {
    inject: [runtimeDiagnosticsContract],
    apply(ctx) {
      const diagnostics = ctx.service<RuntimeDiagnosticsService>(runtimeDiagnosticsContract);
      ctx.effect(() => {
        ipcMain.handle(desktopChannels.runtimeSnapshot, async (event) => {
          if (!config.authorize(event)) {
            throw new Error("runtime snapshot request rejected");
          }

          // IPC 只传输诊断组件产出的稳定 DTO，不暴露 Supervisor 的内部状态表。
          const snapshot = await diagnostics.getSnapshot();
          config.onRuntimeSnapshotServed?.(snapshot);
          return snapshot;
        });

        return () => {
          ipcMain.removeHandler(desktopChannels.runtimeSnapshot);
        };
      }, "desktop runtime snapshot contract");
    },
  };
}
