import {
  agentInvocationContract,
  agentModelConfigurationContract,
  agentSessionContract,
  javaRuntimeManagerContract,
  serverConfigurationContract,
  serverRuntimeContract,
  serverSettingsContract,
  type ServerConsoleLine,
  type ServerConfigurationWriteRequest,
  type ServerStartupDefaultsUpdate,
  type ServerInstanceStartupSettings,
  type ServerModSearchRequest,
  type ServerModSource,
  type ServerModrinthResourceType,
} from "@seashard/contracts";
import {
  createDesktopShellModule,
  createElectronDesktopShellRuntime,
  desktopShellManifest,
} from "@seashard/desktop-shell";
import { downloadContract } from "@seashard/download";
import type { JsonValue } from "@seashard/plugin-sdk";
import { projectClientEntryPublication, type PluginKernel } from "@seashard/plugin-system";
import { serverCoreSourceContract } from "@seashard/server-core-source";
import { serverModSourceContract } from "@seashard/server-mod-source";
import { serverInstanceManagerContract } from "@seashard/server-instance-manager";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { isAbsolute, join } from "node:path";
import {
  expectAgentInvocation,
  expectAgentModelConfiguration,
  expectAgentModelConnectionModels,
  expectAgentInvocationReference,
  expectAgentModels,
  expectAgentSession,
  expectAgentSessions,
  expectFileDownloadTasks,
  expectJavaInstallation,
  expectJavaInstallations,
  expectManagedDownloadResult,
  expectServerConfigurationCatalog,
  expectServerConfigurationDocument,
  expectServerConsoleLines,
  expectServerCoreArtifacts,
  expectServerCoreDownloadTask,
  expectServerCoreDownloadTasks,
  expectServerCoreStrings,
  expectServerCoreTypes,
  expectServerModFilters,
  expectServerModDownloadResult,
  expectServerInstanceContentCounts,
  expectServerInstalledMod,
  expectServerInstalledMods,
  expectServerWorldBackups,
  expectServerWorldBackup,
  expectServerWorldStorageSnapshot,
  expectServerWorldDatapack,
  expectServerWorldDatapacks,
  expectServerModProjectDetails,
  expectServerModSearchResult,
  expectServerInstances,
  expectServerRuntimeSnapshot,
  expectServerSettingsSnapshot,
  expectServerLaunchCommandPreview,
} from "./contract-validation";

const serverConsoleLineListeners = new Set<(line: ServerConsoleLine) => void>();

/** 把运行组件的增量日志发布给当前 Desktop Shell，不让组件直接依赖 Electron。 */
export function publishServerConsoleLine(line: ServerConsoleLine): void {
  for (const listener of serverConsoleLineListeners) listener(line);
}

function onServerConsoleLine(listener: (line: ServerConsoleLine) => void): () => void {
  serverConsoleLineListeners.add(listener);
  return () => serverConsoleLineListeners.delete(listener);
}

interface DesktopShellBridgeOptions {
  readonly kernel: PluginKernel;
  readonly moduleDirectory: string;
  readonly developmentUrl?: string;
  readonly smokeMode: boolean;
}

/** 注册 Electron Shell，并把受校验的 Kernel Contract 适配为 IPC 服务。 */
export async function registerDesktopShellBridge(
  options: DesktopShellBridgeOptions,
): Promise<void> {
  const { kernel, moduleDirectory, developmentUrl, smokeMode } = options;
  let smokeQuitScheduled = false;
  const listFileDownloadTasks = async () =>
    expectFileDownloadTasks(await kernel.callService(downloadContract, "listTasks", []));
  /**
   * Renderer 只能取消已投影到公共下载条的任务，不能借任务 ID 操作图标缓存等内部下载。
   */
  const cancelFileDownload = async (taskId: string): Promise<boolean> => {
    const visibleTasks = await listFileDownloadTasks();
    if (!visibleTasks.some((task) => task.id === taskId)) return false;
    const cancelled = await kernel.callService(downloadContract, "cancel", [taskId]);
    if (typeof cancelled !== "boolean") {
      throw new Error("download service returned an invalid cancellation result");
    }
    return cancelled;
  };
  /** 备份属于磁盘破坏性操作，桥接层统一复核服务端必须已停机。 */
  const ensureServerStoppedForWorldMutation = async (instanceId: string): Promise<void> => {
    const snapshot = expectServerRuntimeSnapshot(
      await kernel.callService(serverRuntimeContract, "get", [instanceId]),
    );
    if (
      snapshot.state === "starting" ||
      snapshot.state === "running" ||
      snapshot.state === "stopping"
    ) {
      throw new Error("需要关停服务器之后才能操作存档备份。");
    }
  };
  // BrowserWindow、Sender 授权和 IPC Handler 属于同一个 Desktop Shell 生命周期。
  await kernel.registerBuiltIn({
    manifest: desktopShellManifest,
    loaders: {
      "desktop-shell.host": {
        load: async () =>
          createDesktopShellModule({
            runtime: createElectronDesktopShellRuntime(
              app,
              BrowserWindow,
              ipcMain,
              dialog,
              protocol,
              net,
              shell,
            ),
            preloadPath: join(moduleDirectory, "../preload/index.cjs"),
            rendererFile: join(moduleDirectory, "../renderer/index.html"),
            ...(developmentUrl ? { developmentUrl } : {}),
            smokeMode,
            reportOpenFailure: (error) => console.error("Desktop window open failed", error),
            readClientEntryPublication: () =>
              projectClientEntryPublication(kernel.clientEntrySnapshot()),
            onClientEntriesChanged: (listener) =>
              kernel.onClientEntriesChanged((snapshot) =>
                listener(projectClientEntryPublication(snapshot)),
              ),
            listAgentModels: async () =>
              expectAgentModels(await kernel.callService(agentSessionContract, "listModels", [])),
            listAgentSessions: async () =>
              expectAgentSessions(
                await kernel.callService(agentSessionContract, "listSessions", []),
              ),
            readAgentSession: async (sessionId) =>
              expectAgentSession(
                await kernel.callService(agentSessionContract, "getSession", [sessionId]),
              ),
            startAgentSession: async (input) =>
              expectAgentInvocationReference(
                await kernel.callService(agentSessionContract, "startSession", [
                  input as unknown as JsonValue,
                ]),
              ),
            sendAgentMessage: async (input) =>
              expectAgentInvocationReference(
                await kernel.callService(agentSessionContract, "sendMessage", [
                  input as unknown as JsonValue,
                ]),
              ),
            readAgentInvocation: async (invocationId) =>
              expectAgentInvocation(
                await kernel.callService(agentInvocationContract, "getInvocation", [invocationId]),
              ),
            cancelAgentInvocation: async (invocationId) => {
              await kernel.callService(agentInvocationContract, "cancelInvocation", [invocationId]);
            },
            readAgentModelConfiguration: async () =>
              expectAgentModelConfiguration(
                await kernel.callService(agentModelConfigurationContract, "getConfiguration", []),
              ),
            mutateAgentModelConnection: async (input) =>
              expectAgentModelConfiguration(
                await kernel.callService(agentModelConfigurationContract, "mutateConnection", [
                  input as unknown as JsonValue,
                ]),
              ),
            removeAgentModelConnection: async (input) =>
              expectAgentModelConfiguration(
                await kernel.callService(agentModelConfigurationContract, "removeConnection", [
                  input as unknown as JsonValue,
                ]),
              ),
            resetAgentModelConfiguration: async (input) =>
              expectAgentModelConfiguration(
                await kernel.callService(agentModelConfigurationContract, "resetConfiguration", [
                  input as unknown as JsonValue,
                ]),
              ),
            discoverAgentModels: async (input) =>
              expectAgentModelConnectionModels(
                await kernel.callService(agentModelConfigurationContract, "discoverModels", [
                  input as unknown as JsonValue,
                ]),
              ),
            writeAgentCredential: async (input) =>
              expectAgentModelConfiguration(
                await kernel.callService(agentModelConfigurationContract, "writeCredential", [
                  input as unknown as JsonValue,
                ]),
              ),
            removeAgentCredential: async (input) =>
              expectAgentModelConfiguration(
                await kernel.callService(agentModelConfigurationContract, "removeCredential", [
                  input as unknown as JsonValue,
                ]),
              ),
            openAgentModelConfiguration: async () => {
              await kernel.callService(
                agentModelConfigurationContract,
                "openConfigurationFile",
                [],
              );
            },
            readServerCoreTypes: async () =>
              expectServerCoreTypes(
                await kernel.callService(serverCoreSourceContract, "listTypes", []),
              ),
            readServerCoreVersions: async (serverType) =>
              expectServerCoreStrings(
                await kernel.callService(serverCoreSourceContract, "listVersions", [serverType]),
                "versions",
              ),
            readServerCoreArtifacts: async (serverType, gameVersion) =>
              expectServerCoreArtifacts(
                await kernel.callService(serverCoreSourceContract, "listArtifacts", [
                  serverType,
                  gameVersion,
                ]),
              ),
            readServerModFilters: async (
              resourceType: ServerModrinthResourceType,
              source: ServerModSource,
            ) =>
              expectServerModFilters(
                await kernel.callService(serverModSourceContract, "getFilters", [
                  resourceType,
                  source,
                ]),
              ),
            searchServerMods: async (request: ServerModSearchRequest) =>
              expectServerModSearchResult(
                await kernel.callService(serverModSourceContract, "search", [
                  request as unknown as JsonValue,
                ]),
              ),
            readServerModProjectDetails: async (
              resourceType: ServerModrinthResourceType,
              source: ServerModSource,
              projectId,
            ) =>
              expectServerModProjectDetails(
                await kernel.callService(serverModSourceContract, "getProjectDetails", [
                  resourceType,
                  source,
                  projectId,
                ]),
              ),
            installServerMod: async (request) =>
              expectServerModDownloadResult(
                await kernel.callService(serverModSourceContract, "installToInstance", [
                  request as unknown as JsonValue,
                ]),
              ),
            saveServerMod: async (request) =>
              expectServerModDownloadResult(
                await kernel.callService(serverModSourceContract, "saveToDirectory", [
                  request as unknown as JsonValue,
                ]),
              ),
            resolveServerCoreIconPath: async (sha256) => {
              const path = await kernel.callService(serverCoreSourceContract, "resolveIconPath", [
                sha256,
              ]);
              if (path === null) return undefined;
              if (typeof path !== "string" || !isAbsolute(path)) {
                throw new Error("server core source returned an invalid icon cache path");
              }
              return path;
            },
            resolveServerInstanceIconPath: async (instanceId) => {
              const path = await kernel.callService(
                serverInstanceManagerContract,
                "resolveIconPath",
                [instanceId],
              );
              if (path === null) return undefined;
              if (typeof path !== "string" || !isAbsolute(path)) {
                throw new Error("server instance manager returned an invalid icon path");
              }
              return path;
            },
            readServerSettings: async () =>
              expectServerSettingsSnapshot(
                await kernel.callService(serverSettingsContract, "get", []),
              ),
            writeResourceDownloadDirectory: async (directory) =>
              expectServerSettingsSnapshot(
                await kernel.callService(serverSettingsContract, "setResourceDownloadDirectory", [
                  directory,
                ]),
              ),
            writeDefaultDownloadConnections: async (connections) =>
              expectServerSettingsSnapshot(
                await kernel.callService(serverSettingsContract, "setDefaultDownloadConnections", [
                  connections,
                ]),
              ),
            writeServerStartupDefaults: async (update: ServerStartupDefaultsUpdate) =>
              expectServerSettingsSnapshot(
                await kernel.callService(serverSettingsContract, "setStartupDefaults", [
                  update as unknown as JsonValue,
                ]),
              ),
            startServerCoreDownload: async (request) =>
              expectServerCoreDownloadTask(
                await kernel.callService(serverCoreSourceContract, "start", [
                  request as unknown as JsonValue,
                ]),
              ),
            startManagedServerCoreDownload: async (request) =>
              expectManagedDownloadResult(
                await kernel.callService(serverInstanceManagerContract, "createManaged", [
                  request as unknown as JsonValue,
                ]),
              ),
            listServerInstances: async () =>
              expectServerInstances(
                await kernel.callService(serverInstanceManagerContract, "list", []),
              ),
            readServerInstanceContentCounts: async (instanceId) =>
              expectServerInstanceContentCounts(
                await kernel.callService(serverInstanceManagerContract, "contentCounts", [
                  instanceId,
                ]),
              ),
            listServerMods: async (instanceId) =>
              expectServerInstalledMods(
                await kernel.callService(serverInstanceManagerContract, "listMods", [instanceId]),
              ),
            setServerModDisabled: async (instanceId, relativePath, disabled) => {
              const result = await kernel.callService(
                serverInstanceManagerContract,
                "setModDisabled",
                [instanceId, relativePath, disabled],
              );
              return expectServerInstalledMod(result, relativePath);
            },
            deleteServerMod: async (instanceId, relativePath) => {
              const result = await kernel.callService(serverInstanceManagerContract, "deleteMod", [
                instanceId,
                relativePath,
              ]);
              if (result !== null) {
                throw new Error("server instance manager returned an invalid mod delete result");
              }
            },
            readServerWorldStorage: async (instanceId) =>
              expectServerWorldStorageSnapshot(
                await kernel.callService(serverInstanceManagerContract, "listWorldStorage", [
                  instanceId,
                ]),
              ),
            listServerWorldBackups: async (instanceId, worldId) =>
              expectServerWorldBackups(
                await kernel.callService(serverInstanceManagerContract, "listWorldBackups", [
                  instanceId,
                  worldId,
                ]),
              ),
            listServerWorldDatapacks: async (instanceId, worldId) =>
              expectServerWorldDatapacks(
                await kernel.callService(serverInstanceManagerContract, "listWorldDatapacks", [
                  instanceId,
                  worldId,
                ]),
              ),
            setServerWorldDatapackDisabled: async (instanceId, worldId, fileName, disabled) => {
              await ensureServerStoppedForWorldMutation(instanceId);
              return expectServerWorldDatapack(
                await kernel.callService(
                  serverInstanceManagerContract,
                  "setWorldDatapackDisabled",
                  [instanceId, worldId, fileName, disabled],
                ),
              );
            },
            deleteServerWorldDatapack: async (instanceId, worldId, fileName) => {
              await ensureServerStoppedForWorldMutation(instanceId);
              const result = await kernel.callService(
                serverInstanceManagerContract,
                "deleteWorldDatapack",
                [instanceId, worldId, fileName],
              );
              if (result !== null) {
                throw new Error(
                  "server instance manager returned an invalid datapack delete result",
                );
              }
            },
            createServerWorldBackup: async (instanceId, worldId) => {
              await ensureServerStoppedForWorldMutation(instanceId);
              return expectServerWorldBackup(
                await kernel.callService(serverInstanceManagerContract, "createWorldBackup", [
                  instanceId,
                  worldId,
                ]),
              );
            },
            restoreServerWorldBackup: async (instanceId, worldId, fileName) => {
              await ensureServerStoppedForWorldMutation(instanceId);
              return expectServerWorldStorageSnapshot(
                await kernel.callService(serverInstanceManagerContract, "restoreWorldBackup", [
                  instanceId,
                  worldId,
                  fileName,
                ]),
              );
            },
            deleteServerWorldBackup: async (instanceId, worldId, fileName) => {
              await ensureServerStoppedForWorldMutation(instanceId);
              const result = await kernel.callService(
                serverInstanceManagerContract,
                "deleteWorldBackup",
                [instanceId, worldId, fileName],
              );
              if (result !== null) {
                throw new Error("server instance manager returned an invalid backup delete result");
              }
            },
            switchServerWorld: async (instanceId, worldId) =>
              expectServerWorldStorageSnapshot(
                await kernel.callService(serverInstanceManagerContract, "switchWorld", [
                  instanceId,
                  worldId,
                ]),
              ),
            writeServerInstanceStartupSettings: async (
              instanceId,
              settings: ServerInstanceStartupSettings,
            ) => {
              const [instance] = expectServerInstances([
                await kernel.callService(serverInstanceManagerContract, "setStartupSettings", [
                  instanceId,
                  settings as unknown as JsonValue,
                ]),
              ]);
              if (!instance) {
                throw new Error("server instance manager returned no updated instance");
              }
              return instance;
            },
            writeServerInstanceIcon: async (instanceId, iconDataUrl) => {
              const [instance] = expectServerInstances([
                await kernel.callService(serverInstanceManagerContract, "setIcon", [
                  instanceId,
                  iconDataUrl,
                ]),
              ]);
              if (!instance) {
                throw new Error("server instance manager returned no updated instance");
              }
              return instance;
            },
            deleteServerInstance: async (instanceId) => {
              const result = await kernel.callService(serverInstanceManagerContract, "delete", [
                instanceId,
              ]);
              if (result !== null) {
                throw new Error("server instance manager returned an invalid delete result");
              }
            },
            listServerConfigurations: async (instanceId) =>
              expectServerConfigurationCatalog(
                await kernel.callService(serverConfigurationContract, "list", [instanceId]),
              ),
            readServerConfiguration: async (instanceId, path) =>
              expectServerConfigurationDocument(
                await kernel.callService(serverConfigurationContract, "read", [instanceId, path]),
              ),
            writeServerConfiguration: async (request: ServerConfigurationWriteRequest) =>
              expectServerConfigurationDocument(
                await kernel.callService(serverConfigurationContract, "write", [
                  request as unknown as JsonValue,
                ]),
              ),
            previewServerRuntime: async (instanceId, startupSettings) =>
              expectServerLaunchCommandPreview(
                await kernel.callService(
                  serverRuntimeContract,
                  "preview",
                  startupSettings
                    ? [instanceId, startupSettings as unknown as JsonValue]
                    : [instanceId],
                ),
              ),
            readServerRuntime: async (instanceId) =>
              expectServerRuntimeSnapshot(
                await kernel.callService(serverRuntimeContract, "get", [instanceId]),
              ),
            startServerRuntime: async (instanceId) =>
              expectServerRuntimeSnapshot(
                await kernel.callService(serverRuntimeContract, "start", [instanceId]),
              ),
            stopServerRuntime: async (instanceId) =>
              expectServerRuntimeSnapshot(
                await kernel.callService(serverRuntimeContract, "stop", [instanceId]),
              ),
            sendServerCommand: async (instanceId, command) => {
              const result = await kernel.callService(serverRuntimeContract, "sendCommand", [
                instanceId,
                command,
              ]);
              if (result !== null) {
                throw new Error("server runtime returned an invalid command result");
              }
            },
            readServerConsoleLines: async (instanceId, afterSequence) =>
              expectServerConsoleLines(
                await kernel.callService(serverRuntimeContract, "getLogs", [
                  instanceId,
                  afterSequence,
                ]),
              ),
            onServerConsoleLine,
            scanJavaInstallations: async () =>
              expectJavaInstallations(
                await kernel.callService(javaRuntimeManagerContract, "scan", []),
              ),
            inspectJavaInstallation: async (executablePath) =>
              expectJavaInstallation(
                await kernel.callService(javaRuntimeManagerContract, "inspect", [executablePath]),
              ),
            removeJavaInstallation: async (executablePath) => {
              const removed = await kernel.callService(javaRuntimeManagerContract, "remove", [
                executablePath,
              ]);
              if (typeof removed !== "boolean") {
                throw new Error("java runtime manager returned an invalid removal result");
              }
              return removed;
            },
            setJavaInstallationDisabled: async (installationId, disabled) => {
              const result = await kernel.callService(javaRuntimeManagerContract, "setDisabled", [
                installationId,
                disabled,
              ]);
              if (typeof result !== "boolean" || result !== disabled) {
                throw new Error("java runtime manager returned an invalid disabled state");
              }
              return result;
            },
            listFileDownloadTasks,
            cancelFileDownload,
            listServerCoreDownloadTasks: async () =>
              expectServerCoreDownloadTasks(
                await kernel.callService(serverCoreSourceContract, "listTasks", []),
              ),
            cancelServerCoreDownload: async (taskId) => {
              const cancelled = await kernel.callService(serverCoreSourceContract, "cancel", [
                taskId,
              ]);
              if (typeof cancelled !== "boolean") {
                throw new Error("server core source returned an invalid cancellation result");
              }
              return cancelled;
            },
            onRendererReady: (snapshot) => {
              if (!smokeMode || smokeQuitScheduled) return;
              smokeQuitScheduled = true;
              console.log(`SEASHARD_SMOKE_READY components=${snapshot.components.length}`);
              setTimeout(() => app.quit(), 50).unref();
            },
          }),
      },
    },
    bindings: [
      {
        id: "core.desktop-shell",
        entryId: "desktop-shell.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
}
