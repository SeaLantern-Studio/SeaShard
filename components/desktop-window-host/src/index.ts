import { desktopWindowHostContract } from "@seashard/contracts";
import type { PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import type { App, BrowserWindow, BrowserWindowConstructorOptions } from "electron";

/**
 * Electron 全局对象的最小适配面。
 *
 * Component 决定窗口策略和清理顺序；Desktop Main 只把不可组件化的 Electron 进程对象
 * 适配进来，避免测试必须启动真实 Electron。
 */
export interface DesktopWindowRuntime {
  readonly platform: NodeJS.Platform;
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  getWindowCount(): number;
  onActivate(listener: () => void): void;
  offActivate(listener: () => void): void;
  onWindowAllClosed(listener: () => void): void;
  offWindowAllClosed(listener: () => void): void;
  quit(): void;
}

export interface DesktopWindowHostConfig {
  readonly runtime: DesktopWindowRuntime;
  readonly preloadPath: string;
  readonly rendererFile: string;
  readonly developmentUrl?: string;
  readonly smokeMode: boolean;
  reportOpenFailure(error: unknown): void;
}

/** 把不可序列化的 Electron 进程对象收窄成 Window Host 唯一需要的适配面。 */
export function createElectronDesktopWindowRuntime(
  electronApp: App,
  BrowserWindowClass: typeof BrowserWindow,
): DesktopWindowRuntime {
  return {
    platform: process.platform,
    createWindow: (options) => new BrowserWindowClass(options),
    getWindowCount: () => BrowserWindowClass.getAllWindows().length,
    onActivate: (listener) => electronApp.on("activate", listener),
    offActivate: (listener) => electronApp.off("activate", listener),
    onWindowAllClosed: (listener) => electronApp.on("window-all-closed", listener),
    offWindowAllClosed: (listener) => electronApp.off("window-all-closed", listener),
    quit: () => electronApp.quit(),
  };
}

export const desktopWindowHostManifest: PluginManifest = {
  id: "seashard.desktop-window-host",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "desktop-window-host.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron"],
      activationScopes: ["global"],
      permissions: [],
      // BrowserWindow 是独占宿主资源；替换时必须先销毁旧窗口，不能短暂双开。
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/**
 * 创建主窗口宿主组件。
 *
 * 组件拥有 BrowserWindow、安全策略、Renderer 装载、macOS 重新激活和窗口清理。
 * 初次打开通过 Service 显式触发，使 Main 可以等全部 IPC Gateway 发布后再加载 Renderer；
 * 后续 UI Shell 组件也可以复用同一入口，而不接触 Electron 对象。
 */
export function createDesktopWindowHostModule(config: DesktopWindowHostConfig): PluginModule {
  return {
    provides: [desktopWindowHostContract],
    apply(ctx) {
      let primaryWindow: BrowserWindow | undefined;
      let opening: Promise<void> | undefined;

      const ownsWebContents = (webContentsId: number): boolean =>
        primaryWindow !== undefined &&
        !primaryWindow.isDestroyed() &&
        primaryWindow.webContents.id === webContentsId;

      const createAndLoadPrimary = async (): Promise<void> => {
        const window = config.runtime.createWindow({
          width: 1120,
          height: 720,
          minWidth: 880,
          minHeight: 560,
          show: false,
          autoHideMenuBar: true,
          backgroundColor: "#f3f1eb",
          webPreferences: {
            preload: config.preloadPath,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
          },
        });
        primaryWindow = window;

        // Renderer 只能通过预定义 preload contract 与 Core 通信；窗口本身不获得新窗口或权限能力。
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
          callback(false),
        );
        window.once("ready-to-show", () => {
          if (!config.smokeMode && !window.isDestroyed()) window.show();
        });
        window.on("closed", () => {
          if (primaryWindow === window) primaryWindow = undefined;
        });

        try {
          if (config.developmentUrl) {
            await window.loadURL(config.developmentUrl);
          } else {
            await window.loadFile(config.rendererFile);
          }
        } catch (error) {
          // 失败窗口不能继续占据授权身份；销毁后下一次 activate/openPrimary 可以干净重试。
          if (primaryWindow === window) primaryWindow = undefined;
          if (!window.isDestroyed()) window.destroy();
          throw error;
        }
      };

      const openPrimary = (): Promise<void> => {
        if (primaryWindow && !primaryWindow.isDestroyed()) return Promise.resolve();
        if (opening) return opening;

        const task = createAndLoadPrimary();
        opening = task;
        void task.then(
          () => {
            if (opening === task) opening = undefined;
          },
          () => {
            if (opening === task) opening = undefined;
          },
        );
        return task;
      };

      const handleActivate = (): void => {
        if (config.runtime.getWindowCount() !== 0) return;
        void openPrimary().catch((error) => config.reportOpenFailure(error));
      };
      const handleWindowAllClosed = (): void => {
        if (config.runtime.platform !== "darwin") config.runtime.quit();
      };

      ctx.provide(desktopWindowHostContract, {
        openPrimary,
        ownsWebContents: (webContentsId) => {
          if (typeof webContentsId !== "number" || !Number.isSafeInteger(webContentsId)) {
            throw new TypeError("webContentsId must be a safe integer");
          }
          return ownsWebContents(webContentsId);
        },
      });

      ctx.effect(() => {
        config.runtime.onActivate(handleActivate);
        config.runtime.onWindowAllClosed(handleWindowAllClosed);

        return () => {
          // 先移除 app 监听，再销毁窗口；否则组件热替换会被误判为用户关闭全部窗口并退出应用。
          config.runtime.offActivate(handleActivate);
          config.runtime.offWindowAllClosed(handleWindowAllClosed);
          const window = primaryWindow;
          primaryWindow = undefined;
          if (window && !window.isDestroyed()) window.destroy();
        };
      }, "desktop primary window lifecycle");
    },
  };
}
