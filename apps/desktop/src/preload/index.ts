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
  serverCore: Object.freeze({
    listTypes: () => ipcRenderer.invoke(desktopChannels.serverCoreTypes),
    listVersions: (serverType: string) =>
      ipcRenderer.invoke(desktopChannels.serverCoreVersions, serverType),
    listArtifacts: (serverType: string, gameVersion: string) =>
      ipcRenderer.invoke(desktopChannels.serverCoreArtifacts, serverType, gameVersion),
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
    ready: () => ipcRenderer.invoke(desktopChannels.rendererReady),
  }),
  window: Object.freeze({
    minimize: () => ipcRenderer.invoke(desktopChannels.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(desktopChannels.windowToggleMaximize),
    close: () => ipcRenderer.invoke(desktopChannels.windowClose),
  }),
});

contextBridge.exposeInMainWorld("seashard", api);
