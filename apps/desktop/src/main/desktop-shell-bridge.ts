import {
  agentInvocationContract,
  agentModelConfigurationContract,
  agentSessionContract,
  javaRuntimeManagerContract,
  serverConfigurationContract,
  serverRuntimeContract,
  serverSettingsContract,
  type AgentInvocationService,
  type AgentModelConfigurationService,
  type AgentSessionService,
  type DesktopUpdateClientService,
  type JavaRuntimeManagerService,
  type ServerConfigurationService,
  type ServerConfigurationWriteRequest,
  type ServerConsoleLine,
  type ServerModSearchRequest,
  type ServerModSource,
  type ServerModrinthResourceType,
  type ServerRuntimeService,
  type ServerSettingsClientService,
  type ServerStartupDefaultsUpdate,
} from "@seashard/contracts";
import {
  createDesktopShellModule,
  createElectronDesktopShellRuntime,
  desktopShellManifest,
} from "@seashard/desktop-shell";
import { downloadContract, type DownloadService } from "@seashard/download";
import {
  projectClientEntryPublication,
  resolveClientPluginAssetPath,
  type PluginKernel,
} from "@seashard/plugin-system";
import {
  serverCoreSourceContract,
  type ServerCoreSourceService,
} from "@seashard/server-core-source";
import {
  serverInstanceManagerContract,
  type ServerInstanceManagerService,
} from "@seashard/server-instance-manager";
import { serverModSourceContract, type ServerModSourceService } from "@seashard/server-mod-source";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { join } from "node:path";

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
  readonly desktopUpdates: DesktopUpdateClientService;
  readonly moduleDirectory: string;
  readonly developmentUrl?: string;
  readonly smokeMode: boolean;
}

/** 注册 Electron Shell，并把 Kernel 中的领域 Contract 适配为 IPC 服务。 */
export async function registerDesktopShellBridge(
  options: DesktopShellBridgeOptions,
): Promise<void> {
  const { kernel, moduleDirectory, developmentUrl, smokeMode, desktopUpdates } = options;
  let smokeQuitScheduled = false;
  const agentSessions = kernel.service<AgentSessionService>(agentSessionContract);
  const agentInvocations = kernel.service<AgentInvocationService>(agentInvocationContract);
  const agentModelConfiguration = kernel.service<AgentModelConfigurationService>(
    agentModelConfigurationContract,
  );
  const downloads = kernel.service<DownloadService>(downloadContract);
  const javaRuntimes = kernel.service<JavaRuntimeManagerService>(javaRuntimeManagerContract);
  const serverConfigurations = kernel.service<ServerConfigurationService>(
    serverConfigurationContract,
  );
  const serverCoreSource = kernel.service<ServerCoreSourceService>(serverCoreSourceContract);
  const serverInstances = kernel.service<ServerInstanceManagerService>(
    serverInstanceManagerContract,
  );
  const serverMods = kernel.service<ServerModSourceService>(serverModSourceContract);
  const serverRuntime = kernel.service<ServerRuntimeService>(serverRuntimeContract);
  const serverSettings = kernel.service<ServerSettingsClientService>(serverSettingsContract);
  const listFileDownloadTasks = () => downloads.listUserVisibleTasks();
  /**
   * Renderer 只能取消已投影到公共下载条的任务，不能借任务 ID 操作图标缓存等内部下载。
   */
  const cancelFileDownload = async (taskId: string): Promise<boolean> => {
    const visibleTasks = await listFileDownloadTasks();
    if (!visibleTasks.some((task) => task.id === taskId)) return false;
    return downloads.cancel(taskId);
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
            resolveClientPluginAssetPath: async (requestUrl) =>
              await resolveClientPluginAssetPath(kernel.clientEntrySnapshot(), requestUrl),
            readClientEntryPublication: () =>
              projectClientEntryPublication(kernel.clientEntrySnapshot()),
            onClientEntriesChanged: (listener) =>
              kernel.onClientEntriesChanged((snapshot) =>
                listener(projectClientEntryPublication(snapshot)),
              ),
            callClientService: (request) => kernel.callClientService(request),
            listAgentModels: async () => await agentSessions.listModels(),
            listAgentSessions: async () => await agentSessions.listSessions(),
            readAgentSession: async (sessionId) => await agentSessions.getSession(sessionId),
            copyAgentSession: async (sessionId) => await agentSessions.copySession(sessionId),
            deleteAgentSession: async (sessionId) => await agentSessions.deleteSession(sessionId),
            startAgentSession: async (input) => await agentSessions.startSession(input),
            sendAgentMessage: async (input) => await agentSessions.sendMessage(input),
            readAgentInvocation: async (invocationId) =>
              await agentInvocations.getInvocation(invocationId),
            cancelAgentInvocation: (invocationId) =>
              agentInvocations.cancelInvocation(invocationId),
            respondAgentInteraction: (input) => agentInvocations.respondToInteraction(input),
            readAgentModelConfiguration: async () =>
              await agentModelConfiguration.getConfiguration(),
            mutateAgentModelConnection: async (input) =>
              await agentModelConfiguration.mutateConnection(input),
            removeAgentModelConnection: async (input) =>
              await agentModelConfiguration.removeConnection(input),
            resetAgentModelConfiguration: async (input) =>
              await agentModelConfiguration.resetConfiguration(input),
            discoverAgentModels: async (input) =>
              await agentModelConfiguration.discoverModels(input),
            writeAgentCredential: async (input) =>
              await agentModelConfiguration.writeCredential(input),
            removeAgentCredential: async (input) =>
              await agentModelConfiguration.removeCredential(input),
            openAgentModelConfiguration: () => agentModelConfiguration.openConfigurationFile(),
            readServerCoreTypes: async () => await serverCoreSource.listTypes(),
            readServerCoreVersions: async (serverType) =>
              await serverCoreSource.listVersions(serverType),
            readServerCoreArtifacts: async (serverType, gameVersion) =>
              await serverCoreSource.listArtifacts(serverType, gameVersion),
            readServerModFilters: async (
              resourceType: ServerModrinthResourceType,
              source: ServerModSource,
            ) => await serverMods.getFilters(resourceType, source),
            searchServerMods: async (request: ServerModSearchRequest) =>
              await serverMods.search(request),
            readServerModProjectDetails: async (
              resourceType: ServerModrinthResourceType,
              source: ServerModSource,
              projectId,
            ) => await serverMods.getProjectDetails(resourceType, source, projectId),
            installServerMod: async (request) => await serverMods.installToInstance(request),
            saveServerMod: async (request) => await serverMods.saveAs(request),
            resolveServerCoreIconPath: async (sha256) =>
              (await serverCoreSource.resolveIconPath(sha256)) ?? undefined,
            resolveServerInstanceIconPath: async (instanceId) =>
              (await serverInstances.resolveIconPath(instanceId)) ?? undefined,
            readServerSettings: async () => await serverSettings.get(),
            writeResourceDownloadDirectory: async (directory) =>
              await serverSettings.setResourceDownloadDirectory(directory),
            writeDefaultDownloadConnections: async (connections) =>
              await serverSettings.setDefaultDownloadConnections(connections),
            writeServerStartupDefaults: async (update: ServerStartupDefaultsUpdate) =>
              await serverSettings.setStartupDefaults(update),
            startServerCoreDownload: async (request) => await serverCoreSource.start(request),
            startManagedServerCoreDownload: async (request) =>
              await serverInstances.createManaged(request),
            listServerInstances: async () => await serverInstances.listForClient(),
            readServerInstanceContentCounts: async (instanceId) =>
              await serverInstances.contentCounts(instanceId),
            listServerMods: async (instanceId) => await serverInstances.listMods(instanceId),
            setServerModDisabled: (instanceId, relativePath, disabled) =>
              serverInstances.setModDisabled(instanceId, relativePath, disabled),
            deleteServerMod: (instanceId, relativePath) =>
              serverInstances.deleteMod(instanceId, relativePath),
            readServerWorldStorage: async (instanceId) =>
              await serverInstances.listWorldStorage(instanceId),
            listServerWorldBackups: async (instanceId, worldId) =>
              await serverInstances.listWorldBackups(instanceId, worldId),
            listServerWorldDatapacks: async (instanceId, worldId) =>
              await serverInstances.listWorldDatapacks(instanceId, worldId),
            setServerWorldDatapackDisabled: (instanceId, worldId, fileName, disabled) =>
              serverInstances.setWorldDatapackDisabled(instanceId, worldId, fileName, disabled),
            deleteServerWorldDatapack: (instanceId, worldId, fileName) =>
              serverInstances.deleteWorldDatapack(instanceId, worldId, fileName),
            createServerWorldBackup: (instanceId, worldId) =>
              serverInstances.createWorldBackup(instanceId, worldId),
            restoreServerWorldBackup: (instanceId, worldId, fileName) =>
              serverInstances.restoreWorldBackup(instanceId, worldId, fileName),
            deleteServerWorldBackup: (instanceId, worldId, fileName) =>
              serverInstances.deleteWorldBackup(instanceId, worldId, fileName),
            switchServerWorld: async (instanceId, worldId) =>
              await serverInstances.switchWorld(instanceId, worldId),
            writeServerInstanceStartupSettings: (instanceId, settings) =>
              serverInstances.setStartupSettings(instanceId, settings),
            writeServerInstanceIcon: (instanceId, iconDataUrl) =>
              serverInstances.setIcon(instanceId, iconDataUrl),
            deleteServerInstance: (instanceId) => serverInstances.delete(instanceId),
            listServerConfigurations: async (instanceId) =>
              await serverConfigurations.list(instanceId),
            readServerConfiguration: async (instanceId, path) =>
              await serverConfigurations.read(instanceId, path),
            writeServerConfiguration: async (request: ServerConfigurationWriteRequest) =>
              await serverConfigurations.write(request),
            previewServerRuntime: (instanceId, startupSettings) =>
              serverRuntime.preview(instanceId, startupSettings),
            readServerRuntime: async (instanceId) => await serverRuntime.get(instanceId),
            startServerRuntime: async (instanceId) => await serverRuntime.start(instanceId),
            stopServerRuntime: async (instanceId) => await serverRuntime.stop(instanceId),
            sendServerCommand: (instanceId, command) =>
              serverRuntime.sendCommand(instanceId, command),
            readServerConsoleLines: async (instanceId, afterSequence) =>
              await serverRuntime.getLogs(instanceId, afterSequence),
            onServerConsoleLine,
            scanJavaInstallations: async () => await javaRuntimes.scan(),
            inspectJavaInstallation: async (executablePath) =>
              await javaRuntimes.inspect(executablePath),
            removeJavaInstallation: (executablePath) => javaRuntimes.remove(executablePath),
            setJavaInstallationDisabled: (installationId, disabled) =>
              javaRuntimes.setDisabled(installationId, disabled),
            listFileDownloadTasks,
            cancelFileDownload,
            readDesktopUpdateSnapshot: () => desktopUpdates.getSnapshot(),
            checkDesktopUpdate: () => desktopUpdates.check(),
            applyDesktopUpdate: () => desktopUpdates.apply(),
            onDesktopUpdateChanged: (listener) => desktopUpdates.onSnapshotChanged(listener),
            listServerCoreDownloadTasks: async () => await serverCoreSource.listTasks(),
            cancelServerCoreDownload: (taskId) => serverCoreSource.cancel(taskId),
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
