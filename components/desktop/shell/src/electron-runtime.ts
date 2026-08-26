import type { App, BrowserWindow, Dialog, IpcMain, Net, Protocol, Shell } from "electron";
import { pathToFileURL } from "node:url";
import type { DesktopShellRuntime } from "./types";

/** 把不可序列化的 Electron 进程对象收窄成 Desktop Shell 唯一需要的适配面。 */
export function createElectronDesktopShellRuntime(
  electronApp: App,
  BrowserWindowClass: typeof BrowserWindow,
  electronIpcMain: IpcMain,
  electronDialog: Dialog,
  electronProtocol: Protocol,
  electronNet: Net,
  electronShell: Shell,
): DesktopShellRuntime {
  return {
    platform: process.platform,
    createWindow: (options) => new BrowserWindowClass(options),
    getWindowCount: () => BrowserWindowClass.getAllWindows().length,
    onActivate: (listener) => electronApp.on("activate", listener),
    offActivate: (listener) => electronApp.off("activate", listener),
    onWindowAllClosed: (listener) => electronApp.on("window-all-closed", listener),
    offWindowAllClosed: (listener) => electronApp.off("window-all-closed", listener),
    handle: (channel, listener) => electronIpcMain.handle(channel, listener),
    handleFileProtocol: (scheme, resolvePath) => {
      electronProtocol.handle(scheme, async (request) => {
        const path = await resolvePath(request.url);
        if (!path) return new Response(null, { status: 404 });
        const response = await electronNet.fetch(pathToFileURL(path).href);
        const headers = new Headers(response.headers);
        // Renderer 的 file:// 页面和开发服务器都会以跨源模块请求访问自定义协议。
        headers.set("access-control-allow-origin", "*");
        headers.set("cross-origin-resource-policy", "cross-origin");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      });
    },
    removeProtocolHandler: (scheme) => electronProtocol.unhandle(scheme),
    openPath: (path) => electronShell.openPath(path),
    openExternal: (url) => electronShell.openExternal(url),
    selectDirectory: async (window, options) => {
      const result = await electronDialog.showOpenDialog(window, {
        title: options.title,
        buttonLabel: options.buttonLabel,
        ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    selectFile: async (window, options) => {
      const result = await electronDialog.showOpenDialog(window, {
        title: options.title,
        buttonLabel: options.buttonLabel,
        filters: options.filters.map((filter) => ({
          name: filter.name,
          extensions: [...filter.extensions],
        })),
        properties: ["openFile"],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    removeHandler: (channel) => electronIpcMain.removeHandler(channel),
    quit: () => electronApp.quit(),
  };
}
