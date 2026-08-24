import {
  agentModelConfigurationChangedEvent,
  desktopChannels,
  desktopShellContract,
  runtimeDiagnosticsContract,
  serverCoreIconHost,
  serverInstanceIconHost,
  serverCoreIconScheme,
  type DesktopClientBootstrap,
  type RuntimeDiagnosticsService,
} from "@seashard/contracts";
import type { PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import type { BrowserWindow } from "electron";
import type { DesktopShellConfig } from "./types";
import {
  expectAgentCredentialRemovalInput,
  expectAgentCredentialWriteInput,
  expectAgentModelConfigurationResetInput,
  expectAgentModelConnectionMutationInput,
  expectAgentModelConnectionRemovalInput,
  expectAgentModelDiscoveryInput,
  expectAgentSendMessageInput,
  expectAgentStartSessionInput,
  expectNonEmptyString,
  expectServerInstanceStartupSettings,
  expectSafeInteger,
  expectServerConfigurationWriteRequest,
  expectServerCoreSaveAsRequest,
  expectServerModInstallRequest,
  expectServerModProjectId,
  expectServerModResourceType,
  expectServerModSaveAsRequest,
  expectServerModSearchRequest,
  expectServerModSource,
  expectServerStartupDefaultsUpdate,
  expectString,
} from "./validation";

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
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};
/**
 * Renderer 新窗口统一交给系统浏览器，仅允许无凭据、无自定义端口的 HTTPS 地址。
 * Mod 简介来自远端 Markdown，因此这里是最终的协议安全边界。
 */
function trustedExternalUrl(value: string): string | undefined {
  try {
    if (value.length > 2_048) return undefined;
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.port) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
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
      const deletingServerInstances = new Set<string>();

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
      ctx.on(agentModelConfigurationChangedEvent, (snapshot) => {
        if (!primaryWindow || primaryWindow.isDestroyed()) return;
        primaryWindow.webContents.send(desktopChannels.agentModelConfigurationChanged, snapshot);
      });

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

        window.webContents.setWindowOpenHandler(({ url }) => {
          const externalUrl = trustedExternalUrl(url);
          if (externalUrl) {
            void config.runtime
              .openExternal(externalUrl)
              .catch((error) => config.reportOpenFailure(error));
          }
          return { action: "deny" };
        });
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
        const disposeServerConsoleSubscription = config.onServerConsoleLine((line) => {
          const window = primaryWindow;
          if (!window || window.isDestroyed()) return;
          window.webContents.send(desktopChannels.serverRuntimeConsoleLine, line);
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
        config.runtime.handle(desktopChannels.agentModelsList, (event) => {
          ownedWindow(event.sender.id);
          return config.listAgentModels();
        });
        config.runtime.handle(desktopChannels.agentSessionsList, (event) => {
          ownedWindow(event.sender.id);
          return config.listAgentSessions();
        });
        config.runtime.handle(desktopChannels.agentSessionGet, (event, sessionId) => {
          ownedWindow(event.sender.id);
          return config.readAgentSession(expectNonEmptyString(sessionId, "Agent session ID"));
        });
        config.runtime.handle(desktopChannels.agentSessionStart, (event, input) => {
          ownedWindow(event.sender.id);
          return config.startAgentSession(expectAgentStartSessionInput(input));
        });
        config.runtime.handle(desktopChannels.agentMessageSend, (event, input) => {
          ownedWindow(event.sender.id);
          return config.sendAgentMessage(expectAgentSendMessageInput(input));
        });
        config.runtime.handle(desktopChannels.agentInvocationGet, (event, invocationId) => {
          ownedWindow(event.sender.id);
          return config.readAgentInvocation(
            expectNonEmptyString(invocationId, "Agent invocation ID"),
          );
        });
        config.runtime.handle(desktopChannels.agentInvocationCancel, (event, invocationId) => {
          ownedWindow(event.sender.id);
          return config.cancelAgentInvocation(
            expectNonEmptyString(invocationId, "Agent invocation ID"),
          );
        });
        config.runtime.handle(desktopChannels.agentModelConfigurationGet, (event) => {
          ownedWindow(event.sender.id);
          return config.readAgentModelConfiguration();
        });
        config.runtime.handle(desktopChannels.agentModelConnectionMutate, (event, input) => {
          ownedWindow(event.sender.id);
          return config.mutateAgentModelConnection(expectAgentModelConnectionMutationInput(input));
        });
        config.runtime.handle(desktopChannels.agentModelConnectionRemove, (event, input) => {
          ownedWindow(event.sender.id);
          return config.removeAgentModelConnection(expectAgentModelConnectionRemovalInput(input));
        });
        config.runtime.handle(desktopChannels.agentModelConfigurationReset, (event, input) => {
          ownedWindow(event.sender.id);
          return config.resetAgentModelConfiguration(
            expectAgentModelConfigurationResetInput(input),
          );
        });
        config.runtime.handle(desktopChannels.agentModelDiscover, (event, input) => {
          ownedWindow(event.sender.id);
          return config.discoverAgentModels(expectAgentModelDiscoveryInput(input));
        });
        config.runtime.handle(desktopChannels.agentCredentialWrite, (event, input) => {
          ownedWindow(event.sender.id);
          return config.writeAgentCredential(expectAgentCredentialWriteInput(input));
        });
        config.runtime.handle(desktopChannels.agentCredentialRemove, (event, input) => {
          ownedWindow(event.sender.id);
          return config.removeAgentCredential(expectAgentCredentialRemovalInput(input));
        });
        config.runtime.handle(desktopChannels.agentModelConfigurationOpen, (event) => {
          ownedWindow(event.sender.id);
          return config.openAgentModelConfiguration();
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
        config.runtime.handle(desktopChannels.serverSettingsSetStartupDefaults, (event, value) => {
          ownedWindow(event.sender.id);
          return config.writeServerStartupDefaults(expectServerStartupDefaultsUpdate(value));
        });
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
        config.runtime.handle(desktopChannels.serverInstancesContentCounts, (event, instanceId) => {
          ownedWindow(event.sender.id);
          return config.readServerInstanceContentCounts(
            expectNonEmptyString(instanceId, "server instance id"),
          );
        });
        config.runtime.handle(desktopChannels.serverInstancesMods, (event, instanceId) => {
          ownedWindow(event.sender.id);
          return config.listServerMods(expectNonEmptyString(instanceId, "server instance id"));
        });
        config.runtime.handle(
          desktopChannels.serverInstancesSetModDisabled,
          async (event, instanceId, relativePath, disabled) => {
            ownedWindow(event.sender.id);
            if (typeof disabled !== "boolean") {
              throw new TypeError("server mod disabled must be a boolean");
            }
            const safeInstanceId = expectNonEmptyString(instanceId, "server instance id");
            const runtime = await config.readServerRuntime(safeInstanceId);
            if (isActiveServerState(runtime.state)) {
              throw new Error("需要关停服务器之后才能操作 MOD。");
            }
            return config.setServerModDisabled(
              safeInstanceId,
              expectNonEmptyString(relativePath, "server mod relative path"),
              disabled,
            );
          },
        );
        config.runtime.handle(
          desktopChannels.serverInstancesDeleteMod,
          async (event, instanceId, relativePath) => {
            ownedWindow(event.sender.id);
            const safeInstanceId = expectNonEmptyString(instanceId, "server instance id");
            const runtime = await config.readServerRuntime(safeInstanceId);
            if (isActiveServerState(runtime.state)) {
              throw new Error("需要关停服务器之后才能操作 MOD。");
            }
            return config.deleteServerMod(
              safeInstanceId,
              expectNonEmptyString(relativePath, "server mod relative path"),
            );
          },
        );
        config.runtime.handle(desktopChannels.serverInstancesWorlds, (event, instanceId) => {
          ownedWindow(event.sender.id);
          return config.readServerWorldStorage(
            expectNonEmptyString(instanceId, "server instance id"),
          );
        });
        config.runtime.handle(
          desktopChannels.serverInstancesWorldDatapacks,
          (event, instanceId, worldId) => {
            ownedWindow(event.sender.id);
            return config.listServerWorldDatapacks(
              expectNonEmptyString(instanceId, "server instance id"),
              expectNonEmptyString(worldId, "server world id"),
            );
          },
        );
        config.runtime.handle(
          desktopChannels.serverInstancesSetWorldDatapackDisabled,
          (event, instanceId, worldId, fileName, disabled) => {
            ownedWindow(event.sender.id);
            if (typeof disabled !== "boolean") {
              throw new TypeError("server datapack disabled must be a boolean");
            }
            return config.setServerWorldDatapackDisabled(
              expectNonEmptyString(instanceId, "server instance id"),
              expectNonEmptyString(worldId, "server world id"),
              expectNonEmptyString(fileName, "server datapack file name"),
              disabled,
            );
          },
        );
        config.runtime.handle(
          desktopChannels.serverInstancesDeleteWorldDatapack,
          (event, instanceId, worldId, fileName) => {
            ownedWindow(event.sender.id);
            return config.deleteServerWorldDatapack(
              expectNonEmptyString(instanceId, "server instance id"),
              expectNonEmptyString(worldId, "server world id"),
              expectNonEmptyString(fileName, "server datapack file name"),
            );
          },
        );
        config.runtime.handle(
          desktopChannels.serverInstancesWorldBackups,
          (event, instanceId, worldId) => {
            ownedWindow(event.sender.id);
            return config.listServerWorldBackups(
              expectNonEmptyString(instanceId, "server instance id"),
              expectNonEmptyString(worldId, "server world id"),
            );
          },
        );
        config.runtime.handle(
          desktopChannels.serverInstancesCreateWorldBackup,
          (event, instanceId, worldId) => {
            ownedWindow(event.sender.id);
            return config.createServerWorldBackup(
              expectNonEmptyString(instanceId, "server instance id"),
              expectNonEmptyString(worldId, "server world id"),
            );
          },
        );
        config.runtime.handle(
          desktopChannels.serverInstancesRestoreWorldBackup,
          (event, instanceId, worldId, fileName) => {
            ownedWindow(event.sender.id);
            return config.restoreServerWorldBackup(
              expectNonEmptyString(instanceId, "server instance id"),
              expectNonEmptyString(worldId, "server world id"),
              expectNonEmptyString(fileName, "server world backup file name"),
            );
          },
        );
        config.runtime.handle(
          desktopChannels.serverInstancesDeleteWorldBackup,
          (event, instanceId, worldId, fileName) => {
            ownedWindow(event.sender.id);
            return config.deleteServerWorldBackup(
              expectNonEmptyString(instanceId, "server instance id"),
              expectNonEmptyString(worldId, "server world id"),
              expectNonEmptyString(fileName, "server world backup file name"),
            );
          },
        );
        config.runtime.handle(
          desktopChannels.serverInstancesSwitchWorld,
          async (event, instanceId, worldId) => {
            ownedWindow(event.sender.id);
            const safeInstanceId = expectNonEmptyString(instanceId, "server instance id");
            const runtime = await config.readServerRuntime(safeInstanceId);
            if (isActiveServerState(runtime.state)) {
              throw new Error("需要关停服务器之后才能切换存档。");
            }
            return config.switchServerWorld(
              safeInstanceId,
              expectNonEmptyString(worldId, "server world id"),
            );
          },
        );
        config.runtime.handle(
          desktopChannels.serverInstancesSetStartupSettings,
          (event, instanceId, value) => {
            ownedWindow(event.sender.id);
            return config.writeServerInstanceStartupSettings(
              expectNonEmptyString(instanceId, "server instance id"),
              expectServerInstanceStartupSettings(value),
            );
          },
        );
        config.runtime.handle(
          desktopChannels.serverInstancesSetIcon,
          (event, instanceId, iconDataUrl) => {
            ownedWindow(event.sender.id);
            return config.writeServerInstanceIcon(
              expectNonEmptyString(instanceId, "server instance id"),
              expectNonEmptyString(iconDataUrl, "server instance icon"),
            );
          },
        );
        config.runtime.handle(desktopChannels.serverInstancesOpenFolder, async (event, value) => {
          ownedWindow(event.sender.id);
          const instanceId = expectNonEmptyString(value, "server instance id");
          const instance = (await config.listServerInstances()).find(
            (candidate) => candidate.id === instanceId,
          );
          if (!instance) throw new Error(`找不到服务器实例：${instanceId}`);
          const openError = await config.runtime.openPath(instance.rootPath);
          if (openError) throw new Error(`无法打开服务器文件夹：${openError}`);
        });
        config.runtime.handle(desktopChannels.serverInstancesDelete, async (event, value) => {
          ownedWindow(event.sender.id);
          const instanceId = expectNonEmptyString(value, "server instance id");
          if (deletingServerInstances.has(instanceId)) {
            throw new Error(`server instance ${instanceId} is already being deleted`);
          }
          deletingServerInstances.add(instanceId);
          try {
            const runtime = await config.readServerRuntime(instanceId);
            if (
              runtime.state === "starting" ||
              runtime.state === "running" ||
              runtime.state === "stopping"
            ) {
              throw new Error("请先停止服务器，再删除实例");
            }
            await config.deleteServerInstance(instanceId);
          } finally {
            deletingServerInstances.delete(instanceId);
          }
        });
        config.runtime.handle(desktopChannels.serverConfigurationList, (event, instanceId) => {
          ownedWindow(event.sender.id);
          return config.listServerConfigurations(
            expectNonEmptyString(instanceId, "server instance id"),
          );
        });
        config.runtime.handle(
          desktopChannels.serverConfigurationRead,
          (event, instanceId, path) => {
            ownedWindow(event.sender.id);
            return config.readServerConfiguration(
              expectNonEmptyString(instanceId, "server instance id"),
              expectNonEmptyString(path, "server configuration path"),
            );
          },
        );
        config.runtime.handle(desktopChannels.serverConfigurationWrite, (event, request) => {
          ownedWindow(event.sender.id);
          return config.writeServerConfiguration(expectServerConfigurationWriteRequest(request));
        });
        config.runtime.handle(
          desktopChannels.serverRuntimePreview,
          (event, instanceId, startupSettings) => {
            ownedWindow(event.sender.id);
            return config.previewServerRuntime(
              expectNonEmptyString(instanceId, "server instance id"),
              startupSettings === undefined
                ? undefined
                : expectServerInstanceStartupSettings(startupSettings),
            );
          },
        );
        config.runtime.handle(desktopChannels.serverRuntimeGet, (event, instanceId) => {
          ownedWindow(event.sender.id);
          return config.readServerRuntime(expectNonEmptyString(instanceId, "server instance id"));
        });
        config.runtime.handle(desktopChannels.serverRuntimeStart, (event, value) => {
          ownedWindow(event.sender.id);
          const instanceId = expectNonEmptyString(value, "server instance id");
          if (deletingServerInstances.has(instanceId)) {
            throw new Error(`server instance ${instanceId} is being deleted`);
          }
          return config.startServerRuntime(instanceId);
        });
        config.runtime.handle(desktopChannels.serverRuntimeStop, (event, instanceId) => {
          ownedWindow(event.sender.id);
          return config.stopServerRuntime(expectNonEmptyString(instanceId, "server instance id"));
        });
        config.runtime.handle(
          desktopChannels.serverRuntimeSendCommand,
          (event, instanceId, command) => {
            ownedWindow(event.sender.id);
            return config.sendServerCommand(
              expectNonEmptyString(instanceId, "server instance id"),
              expectNonEmptyString(command, "server command"),
            );
          },
        );
        config.runtime.handle(
          desktopChannels.serverRuntimeGetLogs,
          (event, instanceId, afterSequence = 0) => {
            ownedWindow(event.sender.id);
            return config.readServerConsoleLines(
              expectNonEmptyString(instanceId, "server instance id"),
              expectSafeInteger(afterSequence, "server console sequence"),
            );
          },
        );
        config.runtime.handle(desktopChannels.javaRuntimeScan, (event) => {
          ownedWindow(event.sender.id);
          return config.scanJavaInstallations();
        });
        config.runtime.handle(desktopChannels.javaRuntimeAdd, async (event) => {
          const window = ownedWindow(event.sender.id);
          const executablePath = await config.runtime.selectFile(window, {
            title: "选择 Java 可执行文件",
            buttonLabel: "添加此 Java",
            filters: [
              {
                name: "Java 可执行文件",
                extensions: config.runtime.platform === "win32" ? ["exe"] : ["*"],
              },
            ],
          });
          return executablePath ? config.inspectJavaInstallation(executablePath) : undefined;
        });
        config.runtime.handle(desktopChannels.javaRuntimeRemove, (event, executablePath) => {
          ownedWindow(event.sender.id);
          return config.removeJavaInstallation(
            expectNonEmptyString(executablePath, "Java executable path"),
          );
        });
        config.runtime.handle(
          desktopChannels.javaRuntimeSetDisabled,
          (event, installationId, disabled) => {
            ownedWindow(event.sender.id);
            if (typeof disabled !== "boolean") {
              throw new TypeError("Java disabled state must be a boolean");
            }
            return config.setJavaInstallationDisabled(
              expectNonEmptyString(installationId, "Java installation id"),
              disabled,
            );
          },
        );
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
        config.runtime.handle(desktopChannels.fileDownloadListTasks, (event) => {
          ownedWindow(event.sender.id);
          return config.listFileDownloadTasks();
        });
        config.runtime.handle(desktopChannels.fileDownloadCancel, (event, taskId) => {
          ownedWindow(event.sender.id);
          return config.cancelFileDownload(expectNonEmptyString(taskId, "file download task id"));
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
        config.runtime.handle(
          desktopChannels.serverModFilters,
          async (event, resourceType, source) => {
            if (!ownsWebContents(event.sender.id)) {
              throw new Error("server resource filters request rejected");
            }
            return config.readServerModFilters(
              expectServerModResourceType(resourceType),
              expectServerModSource(source),
            );
          },
        );
        config.runtime.handle(desktopChannels.serverModSearch, async (event, request) => {
          if (!ownsWebContents(event.sender.id)) {
            throw new Error("server resource search request rejected");
          }
          return config.searchServerMods(expectServerModSearchRequest(request));
        });
        config.runtime.handle(
          desktopChannels.serverModProjectDetails,
          async (event, resourceType, source, projectId) => {
            if (!ownsWebContents(event.sender.id)) {
              throw new Error("server resource project details request rejected");
            }
            return config.readServerModProjectDetails(
              expectServerModResourceType(resourceType),
              expectServerModSource(source),
              expectServerModProjectId(projectId),
            );
          },
        );
        config.runtime.handle(desktopChannels.serverModInstallToInstance, async (event, value) => {
          ownedWindow(event.sender.id);
          const request = expectServerModInstallRequest(value);
          const settings = await config.readServerSettings();
          return config.installServerMod({
            ...request,
            connections: settings.defaultDownloadConnections,
          });
        });
        config.runtime.handle(desktopChannels.serverModDownloadSaveAs, async (event, value) => {
          const window = ownedWindow(event.sender.id);
          const request = expectServerModSaveAsRequest(value);
          const settings = await config.readServerSettings();
          const resourceLabel = request.resourceType === "datapack" ? "数据包" : "Mod";
          const destinationDirectory = await config.runtime.selectDirectory(window, {
            title: `选择${resourceLabel}保存文件夹`,
            buttonLabel: "保存到此文件夹",
            defaultPath: settings.resourceDownloadDirectory,
          });
          if (!destinationDirectory) return undefined;
          return config.saveServerMod({
            ...request,
            destinationDirectory,
            connections: settings.defaultDownloadConnections,
          });
        });
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
          disposeServerConsoleSubscription();
          config.runtime.removeProtocolHandler(serverCoreIconScheme);
          const window = primaryWindow;
          primaryWindow = undefined;
          if (window && !window.isDestroyed()) window.destroy();
          config.runtime.removeHandler(desktopChannels.runtimeSnapshot);
          config.runtime.removeHandler(desktopChannels.serverCoreTypes);
          config.runtime.removeHandler(desktopChannels.serverCoreVersions);
          config.runtime.removeHandler(desktopChannels.serverCoreArtifacts);
          config.runtime.removeHandler(desktopChannels.serverModFilters);
          config.runtime.removeHandler(desktopChannels.serverModSearch);
          config.runtime.removeHandler(desktopChannels.serverModProjectDetails);
          config.runtime.removeHandler(desktopChannels.serverModInstallToInstance);
          config.runtime.removeHandler(desktopChannels.serverModDownloadSaveAs);
          config.runtime.removeHandler(desktopChannels.serverSettingsGet);
          config.runtime.removeHandler(desktopChannels.serverSettingsSetResourceDownloadDirectory);
          config.runtime.removeHandler(desktopChannels.serverSettingsSetDefaultDownloadConnections);
          config.runtime.removeHandler(desktopChannels.serverSettingsSetStartupDefaults);
          config.runtime.removeHandler(desktopChannels.serverCoreDownloadSaveAs);
          config.runtime.removeHandler(desktopChannels.serverCoreDownloadStartManaged);
          config.runtime.removeHandler(desktopChannels.serverInstancesList);
          config.runtime.removeHandler(desktopChannels.serverInstancesContentCounts);
          config.runtime.removeHandler(desktopChannels.serverInstancesWorlds);
          config.runtime.removeHandler(desktopChannels.serverInstancesSwitchWorld);
          config.runtime.removeHandler(desktopChannels.serverInstancesSetStartupSettings);
          config.runtime.removeHandler(desktopChannels.serverInstancesSetIcon);
          config.runtime.removeHandler(desktopChannels.serverInstancesOpenFolder);
          config.runtime.removeHandler(desktopChannels.serverInstancesDelete);
          config.runtime.removeHandler(desktopChannels.serverInstancesWorldBackups);
          config.runtime.removeHandler(desktopChannels.serverInstancesWorldDatapacks);
          config.runtime.removeHandler(desktopChannels.serverInstancesSetWorldDatapackDisabled);
          config.runtime.removeHandler(desktopChannels.serverInstancesDeleteWorldDatapack);
          config.runtime.removeHandler(desktopChannels.serverInstancesCreateWorldBackup);
          config.runtime.removeHandler(desktopChannels.serverInstancesRestoreWorldBackup);
          config.runtime.removeHandler(desktopChannels.serverInstancesDeleteWorldBackup);
          config.runtime.removeHandler(desktopChannels.serverConfigurationList);
          config.runtime.removeHandler(desktopChannels.serverConfigurationRead);
          config.runtime.removeHandler(desktopChannels.serverConfigurationWrite);
          config.runtime.removeHandler(desktopChannels.serverRuntimeGet);
          config.runtime.removeHandler(desktopChannels.serverRuntimePreview);
          config.runtime.removeHandler(desktopChannels.serverRuntimeStart);
          config.runtime.removeHandler(desktopChannels.serverRuntimeStop);
          config.runtime.removeHandler(desktopChannels.serverRuntimeSendCommand);
          config.runtime.removeHandler(desktopChannels.serverRuntimeGetLogs);
          config.runtime.removeHandler(desktopChannels.javaRuntimeScan);
          config.runtime.removeHandler(desktopChannels.javaRuntimeAdd);
          config.runtime.removeHandler(desktopChannels.javaRuntimeRemove);
          config.runtime.removeHandler(desktopChannels.javaRuntimeSetDisabled);
          config.runtime.removeHandler(desktopChannels.serverCoreDownloadListTasks);
          config.runtime.removeHandler(desktopChannels.serverCoreDownloadCancel);
          config.runtime.removeHandler(desktopChannels.fileDownloadListTasks);
          config.runtime.removeHandler(desktopChannels.fileDownloadCancel);
          config.runtime.removeHandler(desktopChannels.agentModelsList);
          config.runtime.removeHandler(desktopChannels.agentSessionsList);
          config.runtime.removeHandler(desktopChannels.agentSessionGet);
          config.runtime.removeHandler(desktopChannels.agentSessionStart);
          config.runtime.removeHandler(desktopChannels.agentMessageSend);
          config.runtime.removeHandler(desktopChannels.agentInvocationGet);
          config.runtime.removeHandler(desktopChannels.agentInvocationCancel);
          config.runtime.removeHandler(desktopChannels.agentModelConfigurationGet);
          config.runtime.removeHandler(desktopChannels.agentModelConnectionMutate);
          config.runtime.removeHandler(desktopChannels.agentModelConnectionRemove);
          config.runtime.removeHandler(desktopChannels.agentModelConfigurationReset);
          config.runtime.removeHandler(desktopChannels.agentModelDiscover);
          config.runtime.removeHandler(desktopChannels.agentCredentialWrite);
          config.runtime.removeHandler(desktopChannels.agentCredentialRemove);
          config.runtime.removeHandler(desktopChannels.agentModelConfigurationOpen);
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

function isActiveServerState(
  state: "stopped" | "starting" | "running" | "stopping" | "failed",
): boolean {
  return state === "starting" || state === "running" || state === "stopping";
}
