import { desktopChannels, type RuntimeSnapshot } from "@seashard/contracts";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { Context, Plugin } from "cordis";

export interface DesktopGatewayConfig {
  authorize(event: IpcMainInvokeEvent): boolean;
  getRuntimeSnapshot(): RuntimeSnapshot;
  onRuntimeSnapshotServed?(snapshot: RuntimeSnapshot): void;
}

export const desktopGatewayPlugin = {
  name: "seashard.desktop-gateway",
  apply(ctx: Context, config: DesktopGatewayConfig) {
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
} satisfies Plugin<DesktopGatewayConfig>;
