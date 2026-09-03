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
  type JavaRuntimeManagerService,
  type ServerConfigurationService,
  type ServerConfigurationWriteRequest,
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
  serverCoreSourceContract,
  type ServerCoreSourceService,
} from "@seashard/server-core-source";
import {
  serverInstanceManagerContract,
  type ServerInstanceManagerService,
} from "@seashard/server-instance-manager";
import { serverModSourceContract, type ServerModSourceService } from "@seashard/server-mod-source";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import {
  coordinateDesktopUpdateCompletion,
  type DesktopUpdateCompletionContext,
} from "./desktop-update-controller";
import type { ElectronDesktopUpdateService } from "./desktop-update";
import { join } from "node:path";
import type { DesktopControllerKernel } from "./desktop-controller-kernel";

const desktopUpdateStartupSettlementTimeoutMs = 30 * 60 * 1_000;
const desktopUpdateServerStopTimeoutMs = 60_000;

interface DesktopShellBridgeOptions {
  readonly kernel: DesktopControllerKernel;
  readonly desktopUpdates: ElectronDesktopUpdateService;
  readonly moduleDirectory: string;
  readonly developmentUrl?: string;
  readonly smokeMode: boolean;
  readonly onControllerWindowAllClosed: () => void;
}

/** 注册 Electron Shell，并把 Kernel 中的领域 Contract 适配为 IPC 服务。 */
export async function registerDesktopShellBridge(
  options: DesktopShellBridgeOptions,
): Promise<void> {
  const {
    kernel,
    moduleDirectory,
    developmentUrl,
    smokeMode,
    desktopUpdates,
    onControllerWindowAllClosed,
  } = options;
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
  const desktopUpdateCompletionContext: DesktopUpdateCompletionContext = {
    listServerInstances: () => serverInstances.list(),
    readServerRuntime: (instanceId) => serverRuntime.get(instanceId),
    waitUntilServerStartupSettled: (instanceId) =>
      serverRuntime.waitUntilStartupSettled(instanceId, desktopUpdateStartupSettlementTimeoutMs),
    stopServerRuntime: (instanceId) => serverRuntime.stop(instanceId),
    waitUntilServerStopped: (instanceId) =>
      serverRuntime.waitUntilStopped(instanceId, desktopUpdateServerStopTimeoutMs),
    install: async (afterInstall) => {
      const updateSnapshot = desktopUpdates.getSnapshot();
      const updatesLocalHost = updateSnapshot.availableComponents?.includes("local-host") ?? false;
      const disconnectBeforeInstall = updatesLocalHost && updateSnapshot.platform !== "macos";
      if (disconnectBeforeInstall) {
        // 主动释放旧 RPC 客户端，避免新 Host 已就绪时 retry 仍误用即将关闭的连接。
        await kernel.hosts.disconnect("local");
      }
      try {
        const result = await desktopUpdates.install(afterInstall);
        if (result.localHostUpdated && !result.controllerInstallerStarted) {
          await kernel.hosts.retry("local");
        }
      } catch (error) {
        if (disconnectBeforeInstall) await kernel.hosts.retry("local").catch(() => undefined);
        throw error;
      }
    },
  };
  const applyDesktopUpdate = async () => {
    const preparation = await desktopUpdates.prepare();
    if (preparation === "external-download") return undefined;
    return coordinateDesktopUpdateCompletion(desktopUpdateCompletionContext, {
      stopRunningServers: false,
      afterInstall: "restart",
    });
  };
  const finishDesktopUpdate = (request: Parameters<typeof coordinateDesktopUpdateCompletion>[1]) =>
    coordinateDesktopUpdateCompletion(desktopUpdateCompletionContext, request);

  const listFileDownloadTasks = () =>
    kernel.hosts.client ? downloads.listUserVisibleTasks() : Promise.resolve([]);
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
            runtime: {
              ...createElectronDesktopShellRuntime(
                app,
                BrowserWindow,
                ipcMain,
                dialog,
                protocol,
                net,
                shell,
              ),
              quit: onControllerWindowAllClosed,
            },
            preloadPath: join(moduleDirectory, "../preload/index.cjs"),
            rendererFile: join(moduleDirectory, "../renderer/index.html"),
            ...(developmentUrl ? { developmentUrl } : {}),
            smokeMode,
            reportOpenFailure: (error) => console.error("Desktop window open failed", error),
            readHostConnections: () => kernel.hosts.getSnapshot(),
            installLocalHost: (hostId) => kernel.hosts.install(hostId),
            retryHostConnection: (hostId) => kernel.hosts.retry(hostId),
            disconnectHost: (hostId) => kernel.hosts.disconnect(hostId),
            requestHostControl: (hostId) => kernel.hosts.requestControl(hostId),
            confirmHostControl: (hostId, requestId) =>
              kernel.hosts.confirmControl(hostId, requestId),
            rejectHostControl: (hostId, requestId) => kernel.hosts.rejectControl(hostId, requestId),
            acknowledgeHostConflict: (hostId) => kernel.hosts.acknowledgeConflict(hostId),
            onHostConnectionsChanged: (listener) => kernel.hosts.onChanged(listener),
            resolveClientPluginAssetPath: (requestUrl) =>
              kernel.resolveClientPluginAssetPath(requestUrl),
            readClientEntryPublication: () => kernel.readClientEntryPublication(),
            onClientEntriesChanged: (listener) => kernel.onClientEntriesChanged(listener),
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
            listServerPlugins: async (instanceId) => await serverInstances.listPlugins(instanceId),
            setServerPluginDisabled: (instanceId, relativePath, disabled) =>
              serverInstances.setPluginDisabled(instanceId, relativePath, disabled),
            deleteServerPlugin: (instanceId, relativePath) =>
              serverInstances.deletePlugin(instanceId, relativePath),
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
            waitUntilServerStartupSettled: (instanceId, timeoutMs) =>
              serverRuntime.waitUntilStartupSettled(instanceId, timeoutMs),
            waitUntilServerStopped: (instanceId, timeoutMs) =>
              serverRuntime.waitUntilStopped(instanceId, timeoutMs),
            sendServerCommand: (instanceId, command) =>
              serverRuntime.sendCommand(instanceId, command),
            readServerConsoleLines: async (instanceId, afterSequence) =>
              await serverRuntime.getLogs(instanceId, afterSequence),
            onServerConsoleLine: (listener) => kernel.onServerConsoleLine(listener),
            scanJavaInstallations: async () => await javaRuntimes.scan(),
            inspectJavaInstallation: async (executablePath) =>
              await javaRuntimes.inspect(executablePath),
            removeJavaInstallation: (executablePath) => javaRuntimes.remove(executablePath),
            setJavaInstallationDisabled: (installationId, disabled) =>
              javaRuntimes.setDisabled(installationId, disabled),
            listFileDownloadTasks,
            cancelFileDownload,
            readDesktopUpdateSnapshot: async () => desktopUpdates.getSnapshot(),
            checkDesktopUpdate: () => desktopUpdates.check(),
            applyDesktopUpdate,
            finishDesktopUpdate,
            shouldConfirmDesktopUpdateExit: () => desktopUpdates.isRestartRequired(),
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
