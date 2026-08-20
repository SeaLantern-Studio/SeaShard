import {
  javaRuntimeManagerContract,
  serverConfigurationContract,
  serverRuntimeContract,
  serverSettingsContract,
  type ServerConsoleLine,
  type ServerConfigurationWriteRequest,
  type ServerStartupDefaultsUpdate,
  type ServerModSearchRequest,
} from "@seashard/contracts";
import {
  createDesktopShellModule,
  createElectronDesktopShellRuntime,
  desktopShellManifest,
} from "@seashard/desktop-shell";
import type { JsonValue } from "@seashard/plugin-sdk";
import { projectClientEntryPublication, type PluginKernel } from "@seashard/plugin-system";
import { serverCoreSourceContract } from "@seashard/server-core-source";
import { serverModSourceContract } from "@seashard/server-mod-source";
import { serverInstanceManagerContract } from "@seashard/server-instance-manager";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { isAbsolute, join } from "node:path";
import {
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
  expectServerModProjectDetails,
  expectServerModSearchResult,
  expectServerInstances,
  expectServerRuntimeSnapshot,
  expectServerSettingsSnapshot,
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
            readServerModFilters: async () =>
              expectServerModFilters(
                await kernel.callService(serverModSourceContract, "getFilters", []),
              ),
            searchServerMods: async (request: ServerModSearchRequest) =>
              expectServerModSearchResult(
                await kernel.callService(serverModSourceContract, "search", [
                  request as unknown as JsonValue,
                ]),
              ),
            readServerModProjectDetails: async (projectId) =>
              expectServerModProjectDetails(
                await kernel.callService(serverModSourceContract, "getProjectDetails", [projectId]),
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
