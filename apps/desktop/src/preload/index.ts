import {
  desktopChannels,
  type DesktopClientBootstrap,
  type SeaShardDesktopApi,
} from "@seashard/contracts";
import { contextBridge, ipcRenderer } from "electron";

const api: SeaShardDesktopApi = Object.freeze({
  runtime: Object.freeze({
    getSnapshot: () => ipcRenderer.invoke(desktopChannels.runtimeSnapshot),
  }),
  client: Object.freeze({
    getBootstrap: () => ipcRenderer.invoke(desktopChannels.clientBootstrap),
    onBootstrapChanged: (listener: (snapshot: DesktopClientBootstrap) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        snapshot: DesktopClientBootstrap,
      ): void => {
        listener(snapshot);
      };
      ipcRenderer.on(desktopChannels.clientBootstrapChanged, handler);
      return () => ipcRenderer.removeListener(desktopChannels.clientBootstrapChanged, handler);
    },
  }),
});

contextBridge.exposeInMainWorld("seashard", api);
