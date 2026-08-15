import { desktopChannels, type RuntimeSnapshot } from "@seashard/contracts";
import type { PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import { ipcMain, type IpcMainInvokeEvent } from "electron";

export interface DesktopGatewayConfig {
  authorize(event: IpcMainInvokeEvent): boolean;
  getRuntimeSnapshot(): RuntimeSnapshot;
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
      permissions: [],
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

export function createDesktopGatewayModule(config: DesktopGatewayConfig): PluginModule {
  return {
    apply(ctx) {
      ctx.effect(() => {
        ipcMain.handle(desktopChannels.runtimeSnapshot, (event) => {
          if (!config.authorize(event)) {
            throw new Error("runtime snapshot request rejected");
          }
          const snapshot = config.getRuntimeSnapshot();
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
