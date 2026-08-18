import {
  desktopChannels,
  desktopShellContract,
  runtimeDiagnosticsContract,
  serverCoreIconHost,
  serverInstanceIconHost,
  serverCoreIconScheme,
  type ClientEntryPublication,
  type DesktopClientBootstrap,
  type RuntimeDiagnosticsService,
  type RuntimeSnapshot,
  type ServerCoreDownloadClientService,
  type ServerCoreDownloadTaskSnapshot,
  type ServerCoreManagedDownloadResult,
  type ServerCoreManagedDownloadRequest,
  type ServerCoreSaveAsRequest,
  type ServerCoreSourceClientService,
  type ServerInstanceClientService,
  type ServerSettingsClientService,
} from "@seashard/contracts";
import type { PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import type {
  App,
  BrowserWindow,
  BrowserWindowConstructorOptions,
  IpcMain,
  Dialog,
  IpcMainInvokeEvent,
  Net,
  Protocol,
} from "electron";
import { pathToFileURL } from "node:url";

export interface DirectorySelectionOptions {
  readonly title: string;
  readonly buttonLabel: string;
  readonly defaultPath?: string;
}

export interface StartDesktopServerCoreDownloadRequest extends ServerCoreSaveAsRequest {
  readonly destinationDirectory: string;
  readonly connections: number;
}

export interface StartDesktopManagedServerCoreDownloadRequest extends ServerCoreManagedDownloadRequest {
  readonly connections: number;
}

/** Electron 全局对象的最小适配面，便于在不启动 Electron 的情况下验证完整 Shell。 */
export interface DesktopShellRuntime {
  readonly platform: NodeJS.Platform;
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  getWindowCount(): number;
  onActivate(listener: () => void): void;
  offActivate(listener: () => void): void;
  onWindowAllClosed(listener: () => void): void;
  offWindowAllClosed(listener: () => void): void;
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void;
  removeHandler(channel: string): void;
  handleFileProtocol(
    scheme: string,
    resolvePath: (requestUrl: string) => Promise<string | undefined>,
  ): void;
  removeProtocolHandler(scheme: string): void;
  selectDirectory(
    window: BrowserWindow,
    options: DirectorySelectionOptions,
  ): Promise<string | undefined>;
  quit(): void;
}

export interface DesktopShellConfig {
  readonly runtime: DesktopShellRuntime;
  readonly preloadPath: string;
  readonly rendererFile: string;
  readonly developmentUrl?: string;
  readonly smokeMode: boolean;
  reportOpenFailure(error: unknown): void;
  onRendererReady?(snapshot: RuntimeSnapshot): void | Promise<void>;
  readServerCoreTypes(): ReturnType<ServerCoreSourceClientService["listTypes"]>;
  readServerCoreVersions(
    serverType: string,
  ): ReturnType<ServerCoreSourceClientService["listVersions"]>;
  readServerCoreArtifacts(
    serverType: string,
    gameVersion: string,
  ): ReturnType<ServerCoreSourceClientService["listArtifacts"]>;
  resolveServerCoreIconPath(sha256: string): Promise<string | undefined>;
  resolveServerInstanceIconPath(instanceId: string): Promise<string | undefined>;
  readServerSettings(): ReturnType<ServerSettingsClientService["get"]>;
  writeResourceDownloadDirectory(
    directory: string,
  ): ReturnType<ServerSettingsClientService["setResourceDownloadDirectory"]>;
  writeDefaultDownloadConnections(
    connections: number,
  ): ReturnType<ServerSettingsClientService["setDefaultDownloadConnections"]>;
  startServerCoreDownload(
    request: StartDesktopServerCoreDownloadRequest,
  ): Promise<ServerCoreDownloadTaskSnapshot>;
  startManagedServerCoreDownload(
    request: StartDesktopManagedServerCoreDownloadRequest,
  ): Promise<ServerCoreManagedDownloadResult>;
  listServerInstances(): ReturnType<ServerInstanceClientService["list"]>;
  listServerCoreDownloadTasks(): ReturnType<ServerCoreDownloadClientService["listTasks"]>;
  cancelServerCoreDownload(taskId: string): ReturnType<ServerCoreDownloadClientService["cancel"]>;
  readClientEntryPublication(): ClientEntryPublication;
  onClientEntriesChanged(listener: (publication: ClientEntryPublication) => void): () => void;
}

/** 把不可序列化的 Electron 进程对象收窄成 Desktop Shell 唯一需要的适配面。 */
export function createElectronDesktopShellRuntime(
  electronApp: App,
  BrowserWindowClass: typeof BrowserWindow,
  electronIpcMain: IpcMain,
  electronDialog: Dialog,
  electronProtocol: Protocol,
  electronNet: Net,
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
        return electronNet.fetch(pathToFileURL(path).href);
      });
    },
    removeProtocolHandler: (scheme) => electronProtocol.unhandle(scheme),
    selectDirectory: async (window, options) => {
      const result = await electronDialog.showOpenDialog(window, {
        title: options.title,
        buttonLabel: options.buttonLabel,
        ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    removeHandler: (channel) => electronIpcMain.removeHandler(channel),
    quit: () => electronApp.quit(),
  };
}

export const desktopShellManifest: PluginManifest = {
  id: "seashard.desktop-shell",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "desktop-shell.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron"],
      activationScopes: ["global"],
      permissions: [runtimeDiagnosticsContract],
      // BrowserWindow 和 ipcMain Channel 都是 Electron 进程级独占资源。
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

function expectNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function expectSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
  return value as number;
}

function expectServerCoreSaveAsRequest(value: unknown): ServerCoreSaveAsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("server core save-as request must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    serverType: expectNonEmptyString(record.serverType, "server core type"),
    gameVersion: expectNonEmptyString(record.gameVersion, "game version"),
    artifactFileName: expectNonEmptyString(record.artifactFileName, "artifact file name"),
    destinationFileName: expectNonEmptyString(record.destinationFileName, "destination file name"),
  };
}

/**
 * 创建完整 Desktop Shell。
 *
 * 窗口、Sender 所有权和 IPC Handler 属于同一个不可拆分的 Electron 生命周期；
 * Runtime Diagnostics 保持独立，只通过类型化 Service 提供跨 Host 的投影结果。
 */
export function createDesktopShellModule(config: DesktopShellConfig): PluginModule {
  return {
    inject: [runtimeDiagnosticsContract],
    provides: [desktopShellContract],
    apply(ctx) {
      const diagnostics = ctx.service<RuntimeDiagnosticsService>(runtimeDiagnosticsContract);
      let primaryWindow: BrowserWindow | undefined;
      let opening: Promise<void> | undefined;

      const ownsWebContents = (webContentsId: number): boolean =>
        Number.isSafeInteger(webContentsId) &&
        primaryWindow !== undefined &&
        !primaryWindow.isDestroyed() &&
        primaryWindow.webContents.id === webContentsId;

      const ownedWindow = (webContentsId: number): BrowserWindow => {
        if (!ownsWebContents(webContentsId) || !primaryWindow) {
          throw new Error("window action request rejected");
        }
        return primaryWindow;
      };

      const createClientBootstrap = (webContentsId: number): DesktopClientBootstrap => ({
        protocolVersion: 1,
        ...config.readClientEntryPublication(),
        clientSession: {
          id: `desktop-primary:${webContentsId}`,
          target: "desktop",
          surface: "primary",
        },
      });

      const createAndLoadPrimary = async (): Promise<void> => {
        const window = config.runtime.createWindow({
          width: 1200,
          height: 720,
          minWidth: 1000,
          minHeight: 625,
          show: false,
          autoHideMenuBar: true,
          titleBarStyle: "hidden",
          backgroundColor: "#f1f5f9",
          webPreferences: {
            preload: config.preloadPath,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
          },
        });
        primaryWindow = window;

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

      ctx.provide(desktopShellContract, { openPrimary });
      ctx.effect(() => {
        const disposeClientEntrySubscription = config.onClientEntriesChanged((publication) => {
          const window = primaryWindow;
          if (!window || window.isDestroyed()) return;
          window.webContents.send(desktopChannels.clientBootstrapChanged, {
            protocolVersion: 1,
            ...publication,
            clientSession: {
              id: `desktop-primary:${window.webContents.id}`,
              target: "desktop",
              surface: "primary",
            },
          } satisfies DesktopClientBootstrap);
        });

        config.runtime.handleFileProtocol(serverCoreIconScheme, async (requestUrl) => {
          let url: URL;
          try {
            url = new URL(requestUrl);
          } catch {
            return undefined;
          }
          if (url.protocol !== `${serverCoreIconScheme}:` || url.search || url.hash) {
            return undefined;
          }
          if (url.hostname === serverCoreIconHost) {
            const sha256 = /^\/([a-f0-9]{64})$/u.exec(url.pathname)?.[1];
            return sha256 ? config.resolveServerCoreIconPath(sha256) : undefined;
          }
          if (url.hostname === serverInstanceIconHost) {
            const instanceId = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u.exec(url.pathname)?.[1];
            return instanceId ? config.resolveServerInstanceIconPath(instanceId) : undefined;
          }
          return undefined;
        });

        config.runtime.handle(desktopChannels.windowMinimize, (event) => {
          ownedWindow(event.sender.id).minimize();
        });
        config.runtime.handle(desktopChannels.windowToggleMaximize, (event) => {
          const window = ownedWindow(event.sender.id);
          if (window.isMaximized()) {
            window.unmaximize();
          } else {
            window.maximize();
          }
          return window.isMaximized();
        });
        config.runtime.handle(desktopChannels.windowClose, (event) => {
          ownedWindow(event.sender.id).close();
        });
        config.runtime.handle(desktopChannels.dialogSelectDirectory, async (event) => {
          const window = ownedWindow(event.sender.id);
          const settings = await config.readServerSettings();
          return config.runtime.selectDirectory(window, {
            title: "选择资源默认下载地址",
            buttonLabel: "选择此文件夹",
            defaultPath: settings.resourceDownloadDirectory,
          });
        });
        config.runtime.handle(desktopChannels.serverSettingsGet, (event) => {
          ownedWindow(event.sender.id);
          return config.readServerSettings();
        });
        config.runtime.handle(
          desktopChannels.serverSettingsSetResourceDownloadDirectory,
          (event, directory) => {
            ownedWindow(event.sender.id);
            return config.writeResourceDownloadDirectory(
              expectString(directory, "resource download directory"),
            );
          },
        );
        config.runtime.handle(
          desktopChannels.serverSettingsSetDefaultDownloadConnections,
          (event, connections) => {
            ownedWindow(event.sender.id);
            return config.writeDefaultDownloadConnections(
              expectSafeInteger(connections, "default download connections"),
            );
          },
        );
        config.runtime.handle(desktopChannels.serverCoreDownloadSaveAs, async (event, value) => {
          const window = ownedWindow(event.sender.id);
          const request = expectServerCoreSaveAsRequest(value);
          const settings = await config.readServerSettings();
          const destinationDirectory = await config.runtime.selectDirectory(window, {
            title: `选择 ${request.destinationFileName} 的保存文件夹`,
            buttonLabel: "保存到此文件夹",
            defaultPath: settings.resourceDownloadDirectory,
          });
          if (!destinationDirectory) return undefined;
          return config.startServerCoreDownload({
            ...request,
            destinationDirectory,
            connections: settings.defaultDownloadConnections,
          });
        });
        config.runtime.handle(
          desktopChannels.serverCoreDownloadStartManaged,
          async (event, value) => {
            ownedWindow(event.sender.id);
            const request = expectServerCoreSaveAsRequest(value);
            const settings = await config.readServerSettings();
            return config.startManagedServerCoreDownload({
              ...request,
              connections: settings.defaultDownloadConnections,
            });
          },
        );
        config.runtime.handle(desktopChannels.serverInstancesList, (event) => {
          ownedWindow(event.sender.id);
          return config.listServerInstances();
        });
        config.runtime.handle(desktopChannels.serverCoreDownloadListTasks, (event) => {
          ownedWindow(event.sender.id);
          return config.listServerCoreDownloadTasks();
        });
        config.runtime.handle(desktopChannels.serverCoreDownloadCancel, (event, taskId) => {
          ownedWindow(event.sender.id);
          return config.cancelServerCoreDownload(
            expectNonEmptyString(taskId, "server core download task id"),
          );
        });

        config.runtime.handle(desktopChannels.runtimeSnapshot, async (event) => {
          if (!ownsWebContents(event.sender.id)) {
            throw new Error("runtime snapshot request rejected");
          }
          const snapshot = await diagnostics.getSnapshot();
          return snapshot;
        });
        config.runtime.handle(desktopChannels.serverCoreTypes, async (event) => {
          if (!ownsWebContents(event.sender.id)) {
            throw new Error("server core types request rejected");
          }
          return config.readServerCoreTypes();
        });
        config.runtime.handle(desktopChannels.serverCoreVersions, async (event, serverType) => {
          if (!ownsWebContents(event.sender.id)) {
            throw new Error("server core versions request rejected");
          }
          return config.readServerCoreVersions(
            expectNonEmptyString(serverType, "server core type"),
          );
        });
        config.runtime.handle(
          desktopChannels.serverCoreArtifacts,
          async (event, serverType, gameVersion) => {
            if (!ownsWebContents(event.sender.id)) {
              throw new Error("server core artifacts request rejected");
            }
            return config.readServerCoreArtifacts(
              expectNonEmptyString(serverType, "server core type"),
              expectNonEmptyString(gameVersion, "game version"),
            );
          },
        );
        config.runtime.handle(desktopChannels.clientBootstrap, (event) => {
          if (!ownsWebContents(event.sender.id)) {
            throw new Error("client bootstrap request rejected");
          }
          return createClientBootstrap(event.sender.id);
        });
        config.runtime.handle(desktopChannels.rendererReady, async (event) => {
          if (!ownsWebContents(event.sender.id)) {
            throw new Error("renderer ready request rejected");
          }
          const snapshot = await diagnostics.getSnapshot();
          await config.onRendererReady?.(snapshot);
        });
        config.runtime.onActivate(handleActivate);
        config.runtime.onWindowAllClosed(handleWindowAllClosed);

        return () => {
          // 先停止事件和本地资源入口，再销毁授权窗口，最后撤销 IPC。
          config.runtime.offActivate(handleActivate);
          config.runtime.offWindowAllClosed(handleWindowAllClosed);
          disposeClientEntrySubscription();
          config.runtime.removeProtocolHandler(serverCoreIconScheme);
          const window = primaryWindow;
          primaryWindow = undefined;
          if (window && !window.isDestroyed()) window.destroy();
          config.runtime.removeHandler(desktopChannels.runtimeSnapshot);
          config.runtime.removeHandler(desktopChannels.serverCoreTypes);
          config.runtime.removeHandler(desktopChannels.serverCoreVersions);
          config.runtime.removeHandler(desktopChannels.serverCoreArtifacts);
          config.runtime.removeHandler(desktopChannels.serverSettingsGet);
          config.runtime.removeHandler(desktopChannels.serverSettingsSetResourceDownloadDirectory);
          config.runtime.removeHandler(desktopChannels.serverSettingsSetDefaultDownloadConnections);
          config.runtime.removeHandler(desktopChannels.serverCoreDownloadSaveAs);
          config.runtime.removeHandler(desktopChannels.serverCoreDownloadStartManaged);
          config.runtime.removeHandler(desktopChannels.serverInstancesList);
          config.runtime.removeHandler(desktopChannels.serverCoreDownloadListTasks);
          config.runtime.removeHandler(desktopChannels.serverCoreDownloadCancel);
          config.runtime.removeHandler(desktopChannels.clientBootstrap);
          config.runtime.removeHandler(desktopChannels.rendererReady);
          config.runtime.removeHandler(desktopChannels.windowMinimize);
          config.runtime.removeHandler(desktopChannels.windowToggleMaximize);
          config.runtime.removeHandler(desktopChannels.dialogSelectDirectory);
          config.runtime.removeHandler(desktopChannels.windowClose);
        };
      }, "desktop shell lifecycle");
    },
  };
}
