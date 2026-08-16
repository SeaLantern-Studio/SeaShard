import {
  desktopChannels,
  desktopWindowHostContract,
  runtimeDiagnosticsContract,
  type DesktopWindowHostService,
  type RuntimeDiagnosticsService,
  type RuntimeSnapshot,
} from "@seashard/contracts";
import type { PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import { ipcMain } from "electron";

export interface DesktopGatewayConfig {
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
      permissions: [desktopWindowHostContract, runtimeDiagnosticsContract],
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/**
 * 创建只负责 Electron IPC 传输的 Desktop Gateway。
 *
 * Generation/Publication/Operation 的解释规则属于 Runtime Diagnostics Component；
 * BrowserWindow 所有权属于 Desktop Window Host。Gateway 只组合两个类型化 Service，
 * 不持有 Supervisor 状态或 Electron 窗口对象。
 */
export function createDesktopGatewayModule(config: DesktopGatewayConfig): PluginModule {
  return {
    inject: [desktopWindowHostContract, runtimeDiagnosticsContract],
    apply(ctx) {
      const windows = ctx.service<DesktopWindowHostService>(desktopWindowHostContract);
      const diagnostics = ctx.service<RuntimeDiagnosticsService>(runtimeDiagnosticsContract);
      ctx.effect(() => {
        ipcMain.handle(desktopChannels.runtimeSnapshot, async (event) => {
          if (!(await windows.ownsWebContents(event.sender.id))) {
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
