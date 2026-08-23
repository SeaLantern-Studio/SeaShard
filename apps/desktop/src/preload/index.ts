import {
  desktopChannels,
  type AgentClientService,
  type DesktopClientBootstrap,
  type SeaShardDesktopApi,
  type ServerCoreManagedDownloadRequest,
  type ServerConsoleLine,
  type ServerCoreSaveAsRequest,
  type ServerConfigurationWriteRequest,
  type ServerModSearchRequest,
  type ServerModInstallRequest,
  type ServerModSaveAsRequest,
  type ServerModSource,
  type ServerModrinthResourceType,
  type ServerInstanceStartupSettings,
  type ServerStartupDefaultsUpdate,
} from "@seashard/contracts";
import { contextBridge, ipcRenderer } from "electron";

const api: SeaShardDesktopApi = Object.freeze({
  runtime: Object.freeze({
    getSnapshot: () => ipcRenderer.invoke(desktopChannels.runtimeSnapshot),
  }),
  agent: Object.freeze({
    listModels: () => ipcRenderer.invoke(desktopChannels.agentModelsList),
    listSessions: () => ipcRenderer.invoke(desktopChannels.agentSessionsList),
    getSession: (sessionId: string) =>
      ipcRenderer.invoke(desktopChannels.agentSessionGet, sessionId),
    startSession: (input: Parameters<AgentClientService["startSession"]>[0]) =>
      ipcRenderer.invoke(desktopChannels.agentSessionStart, input),
    sendMessage: (input: Parameters<AgentClientService["sendMessage"]>[0]) =>
      ipcRenderer.invoke(desktopChannels.agentMessageSend, input),
    getInvocation: (invocationId: string) =>
      ipcRenderer.invoke(desktopChannels.agentInvocationGet, invocationId),
    cancelInvocation: (invocationId: string) =>
      ipcRenderer.invoke(desktopChannels.agentInvocationCancel, invocationId),
  }),
  serverCore: Object.freeze({
    listTypes: () => ipcRenderer.invoke(desktopChannels.serverCoreTypes),
    listVersions: (serverType: string) =>
      ipcRenderer.invoke(desktopChannels.serverCoreVersions, serverType),
    listArtifacts: (serverType: string, gameVersion: string) =>
      ipcRenderer.invoke(desktopChannels.serverCoreArtifacts, serverType, gameVersion),
  }),
  serverMods: Object.freeze({
    getFilters: (resourceType: ServerModrinthResourceType, source: ServerModSource) =>
      ipcRenderer.invoke(desktopChannels.serverModFilters, resourceType, source),
    search: (request: ServerModSearchRequest) =>
      ipcRenderer.invoke(desktopChannels.serverModSearch, request),
    getProjectDetails: (
      resourceType: ServerModrinthResourceType,
      source: ServerModSource,
      projectId: string,
    ) =>
      ipcRenderer.invoke(desktopChannels.serverModProjectDetails, resourceType, source, projectId),
    installToInstance: (request: ServerModInstallRequest) =>
      ipcRenderer.invoke(desktopChannels.serverModInstallToInstance, request),
    saveAs: (request: ServerModSaveAsRequest) =>
      ipcRenderer.invoke(desktopChannels.serverModDownloadSaveAs, request),
  }),
  serverSettings: Object.freeze({
    get: () => ipcRenderer.invoke(desktopChannels.serverSettingsGet),
    setResourceDownloadDirectory: (directory: string) =>
      ipcRenderer.invoke(desktopChannels.serverSettingsSetResourceDownloadDirectory, directory),
    setDefaultDownloadConnections: (connections: number) =>
      ipcRenderer.invoke(desktopChannels.serverSettingsSetDefaultDownloadConnections, connections),
    setStartupDefaults: (update: ServerStartupDefaultsUpdate) =>
      ipcRenderer.invoke(desktopChannels.serverSettingsSetStartupDefaults, update),
  }),
  serverCoreDownload: Object.freeze({
    startManaged: (request: ServerCoreManagedDownloadRequest) =>
      ipcRenderer.invoke(desktopChannels.serverCoreDownloadStartManaged, request),
    saveAs: (request: ServerCoreSaveAsRequest) =>
      ipcRenderer.invoke(desktopChannels.serverCoreDownloadSaveAs, request),
    listTasks: () => ipcRenderer.invoke(desktopChannels.serverCoreDownloadListTasks),
    cancel: (taskId: string) =>
      ipcRenderer.invoke(desktopChannels.serverCoreDownloadCancel, taskId),
  }),
  fileDownloads: Object.freeze({
    listTasks: () => ipcRenderer.invoke(desktopChannels.fileDownloadListTasks),
    cancel: (taskId: string) => ipcRenderer.invoke(desktopChannels.fileDownloadCancel, taskId),
  }),
  serverInstances: Object.freeze({
    list: () => ipcRenderer.invoke(desktopChannels.serverInstancesList),
    contentCounts: (instanceId: string) =>
      ipcRenderer.invoke(desktopChannels.serverInstancesContentCounts, instanceId),
    listMods: (instanceId: string) =>
      ipcRenderer.invoke(desktopChannels.serverInstancesMods, instanceId),
    setModDisabled: (instanceId: string, relativePath: string, disabled: boolean) =>
      ipcRenderer.invoke(
        desktopChannels.serverInstancesSetModDisabled,
        instanceId,
        relativePath,
        disabled,
      ),
    deleteMod: (instanceId: string, relativePath: string) =>
      ipcRenderer.invoke(desktopChannels.serverInstancesDeleteMod, instanceId, relativePath),
    listWorldStorage: (instanceId: string) =>
      ipcRenderer.invoke(desktopChannels.serverInstancesWorlds, instanceId),
    listWorldBackups: (instanceId: string, worldId: string) =>
      ipcRenderer.invoke(desktopChannels.serverInstancesWorldBackups, instanceId, worldId),
    listWorldDatapacks: (instanceId: string, worldId: string) =>
      ipcRenderer.invoke(desktopChannels.serverInstancesWorldDatapacks, instanceId, worldId),
    setWorldDatapackDisabled: (
      instanceId: string,
      worldId: string,
      fileName: string,
      disabled: boolean,
    ) =>
      ipcRenderer.invoke(
        desktopChannels.serverInstancesSetWorldDatapackDisabled,
        instanceId,
        worldId,
        fileName,
        disabled,
      ),
    deleteWorldDatapack: (instanceId: string, worldId: string, fileName: string) =>
      ipcRenderer.invoke(
        desktopChannels.serverInstancesDeleteWorldDatapack,
        instanceId,
        worldId,
        fileName,
      ),
    createWorldBackup: (instanceId: string, worldId: string) =>
      ipcRenderer.invoke(desktopChannels.serverInstancesCreateWorldBackup, instanceId, worldId),
    restoreWorldBackup: (instanceId: string, worldId: string, fileName: string) =>
      ipcRenderer.invoke(
        desktopChannels.serverInstancesRestoreWorldBackup,
        instanceId,
        worldId,
        fileName,
      ),
    deleteWorldBackup: (instanceId: string, worldId: string, fileName: string) =>
      ipcRenderer.invoke(
        desktopChannels.serverInstancesDeleteWorldBackup,
        instanceId,
        worldId,
        fileName,
      ),
    switchWorld: (instanceId: string, worldId: string) =>
      ipcRenderer.invoke(desktopChannels.serverInstancesSwitchWorld, instanceId, worldId),
    setStartupSettings: (instanceId: string, settings: ServerInstanceStartupSettings) =>
      ipcRenderer.invoke(desktopChannels.serverInstancesSetStartupSettings, instanceId, settings),
    setIcon: (instanceId: string, iconDataUrl: string) =>
      ipcRenderer.invoke(desktopChannels.serverInstancesSetIcon, instanceId, iconDataUrl),
    openFolder: (instanceId: string) =>
      ipcRenderer.invoke(desktopChannels.serverInstancesOpenFolder, instanceId),
    delete: (instanceId: string) =>
      ipcRenderer.invoke(desktopChannels.serverInstancesDelete, instanceId),
  }),
  serverConfiguration: Object.freeze({
    list: (instanceId: string) =>
      ipcRenderer.invoke(desktopChannels.serverConfigurationList, instanceId),
    read: (instanceId: string, path: string) =>
      ipcRenderer.invoke(desktopChannels.serverConfigurationRead, instanceId, path),
    write: (request: ServerConfigurationWriteRequest) =>
      ipcRenderer.invoke(desktopChannels.serverConfigurationWrite, request),
  }),
  serverRuntime: Object.freeze({
    get: (instanceId: string) => ipcRenderer.invoke(desktopChannels.serverRuntimeGet, instanceId),
    preview: (instanceId: string, startupSettings?: ServerInstanceStartupSettings) =>
      ipcRenderer.invoke(desktopChannels.serverRuntimePreview, instanceId, startupSettings),
    start: (instanceId: string) =>
      ipcRenderer.invoke(desktopChannels.serverRuntimeStart, instanceId),
    stop: (instanceId: string) => ipcRenderer.invoke(desktopChannels.serverRuntimeStop, instanceId),
    sendCommand: (instanceId: string, command: string) =>
      ipcRenderer.invoke(desktopChannels.serverRuntimeSendCommand, instanceId, command),
    getLogs: (instanceId: string, afterSequence = 0) =>
      ipcRenderer.invoke(desktopChannels.serverRuntimeGetLogs, instanceId, afterSequence),
    onConsoleLine: (listener: (line: ServerConsoleLine) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, line: ServerConsoleLine): void => {
        listener(line);
      };
      ipcRenderer.on(desktopChannels.serverRuntimeConsoleLine, handler);
      return () => ipcRenderer.removeListener(desktopChannels.serverRuntimeConsoleLine, handler);
    },
  }),
  javaRuntime: Object.freeze({
    scan: () => ipcRenderer.invoke(desktopChannels.javaRuntimeScan),
    add: () => ipcRenderer.invoke(desktopChannels.javaRuntimeAdd),
    remove: (executablePath: string) =>
      ipcRenderer.invoke(desktopChannels.javaRuntimeRemove, executablePath),
    setDisabled: (installationId: string, disabled: boolean) =>
      ipcRenderer.invoke(desktopChannels.javaRuntimeSetDisabled, installationId, disabled),
  }),
  dialog: Object.freeze({
    selectDirectory: () => ipcRenderer.invoke(desktopChannels.dialogSelectDirectory),
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
