import type {
  AgentInvocationService,
  AgentModelConfigurationService,
  AgentSessionService,
  ClientEntryPublication,
  ClientServiceCallRequest,
  DesktopUpdateFinishRequest,
  DesktopUpdateFinishResult,
  DesktopUpdateSnapshot,
  FileDownloadClientService,
  FileDownloadTaskSnapshot,
  JavaRuntimeManagerService,
  RuntimeSnapshot,
  ServerConfigurationCatalog,
  ServerConfigurationDocument,
  ServerConfigurationWriteRequest,
  ServerConsoleLine,
  ServerCoreDownloadClientService,
  ServerCoreDownloadTaskSnapshot,
  ServerCoreManagedDownloadRequest,
  ServerCoreManagedDownloadResult,
  ServerCoreSaveAsRequest,
  ServerCoreSourceClientService,
  ServerInstanceClientService,
  ServerInstanceSnapshot,
  ServerInstanceStartupSettings,
  ServerInstalledModSnapshot,
  ServerModDownloadResult,
  ServerModInstallRequest,
  ServerModSaveAsRequest,
  ServerModSearchRequest,
  ServerModSource,
  ServerModSourceClientService,
  ServerModrinthResourceType,
  ServerRuntimeClientService,
  ServerSettingsClientService,
  ServerStartupDefaultsUpdate,
  ServerWorldBackupSnapshot,
  ServerWorldDatapackSnapshot,
  ServerWorldStorageSnapshot,
} from "@seashard/contracts";
import type { JsonValue } from "@seashard/plugin-sdk";
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMainInvokeEvent } from "electron";

export interface DirectorySelectionOptions {
  readonly title: string;
  readonly buttonLabel: string;
  readonly defaultPath?: string;
}

export interface FileSelectionOptions {
  readonly title: string;
  readonly buttonLabel: string;
  readonly filters: readonly {
    readonly name: string;
    readonly extensions: readonly string[];
  }[];
}

export interface StartDesktopServerCoreDownloadRequest extends ServerCoreSaveAsRequest {
  readonly destinationDirectory: string;
  readonly connections: number;
}

export interface StartDesktopManagedServerCoreDownloadRequest extends ServerCoreManagedDownloadRequest {
  readonly connections: number;
}

export interface StartDesktopServerModInstallRequest extends ServerModInstallRequest {
  readonly connections: number;
}

export interface StartDesktopServerModSaveRequest extends ServerModSaveAsRequest {
  readonly destinationDirectory: string;
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
  openPath(path: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  selectDirectory(
    window: BrowserWindow,
    options: DirectorySelectionOptions,
  ): Promise<string | undefined>;
  selectFile(window: BrowserWindow, options: FileSelectionOptions): Promise<string | undefined>;
  quit(): void;
}

export interface DesktopShellConfig {
  readonly runtime: DesktopShellRuntime;
  readonly preloadPath: string;
  readonly rendererFile: string;
  readonly developmentUrl?: string;
  readonly smokeMode: boolean;
  reportOpenFailure(error: unknown): void;
  readDesktopUpdateSnapshot(): Promise<DesktopUpdateSnapshot>;
  checkDesktopUpdate(): Promise<DesktopUpdateSnapshot>;
  applyDesktopUpdate(): Promise<DesktopUpdateFinishResult>;
  finishDesktopUpdate(request: DesktopUpdateFinishRequest): Promise<DesktopUpdateFinishResult>;
  shouldConfirmDesktopUpdateExit(): boolean;
  onDesktopUpdateChanged(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void;
  listAgentModels(): ReturnType<AgentSessionService["listModels"]>;
  listAgentSessions(): ReturnType<AgentSessionService["listSessions"]>;
  readAgentSession(sessionId: string): ReturnType<AgentSessionService["getSession"]>;
  copyAgentSession(sessionId: string): ReturnType<AgentSessionService["copySession"]>;
  deleteAgentSession(sessionId: string): ReturnType<AgentSessionService["deleteSession"]>;
  startAgentSession(
    input: Parameters<AgentSessionService["startSession"]>[0],
  ): ReturnType<AgentSessionService["startSession"]>;
  sendAgentMessage(
    input: Parameters<AgentSessionService["sendMessage"]>[0],
  ): ReturnType<AgentSessionService["sendMessage"]>;
  readAgentInvocation(invocationId: string): ReturnType<AgentInvocationService["getInvocation"]>;
  cancelAgentInvocation(
    invocationId: string,
  ): ReturnType<AgentInvocationService["cancelInvocation"]>;
  respondAgentInteraction(
    input: Parameters<AgentInvocationService["respondToInteraction"]>[0],
  ): ReturnType<AgentInvocationService["respondToInteraction"]>;
  readAgentModelConfiguration(): ReturnType<AgentModelConfigurationService["getConfiguration"]>;
  mutateAgentModelConnection(
    input: Parameters<AgentModelConfigurationService["mutateConnection"]>[0],
  ): ReturnType<AgentModelConfigurationService["mutateConnection"]>;
  removeAgentModelConnection(
    input: Parameters<AgentModelConfigurationService["removeConnection"]>[0],
  ): ReturnType<AgentModelConfigurationService["removeConnection"]>;
  resetAgentModelConfiguration(
    input: Parameters<AgentModelConfigurationService["resetConfiguration"]>[0],
  ): ReturnType<AgentModelConfigurationService["resetConfiguration"]>;
  discoverAgentModels(
    input: Parameters<AgentModelConfigurationService["discoverModels"]>[0],
  ): ReturnType<AgentModelConfigurationService["discoverModels"]>;
  writeAgentCredential(
    input: Parameters<AgentModelConfigurationService["writeCredential"]>[0],
  ): ReturnType<AgentModelConfigurationService["writeCredential"]>;
  removeAgentCredential(
    input: Parameters<AgentModelConfigurationService["removeCredential"]>[0],
  ): ReturnType<AgentModelConfigurationService["removeCredential"]>;
  openAgentModelConfiguration(): ReturnType<
    AgentModelConfigurationService["openConfigurationFile"]
  >;
  onRendererReady?(snapshot: RuntimeSnapshot): void | Promise<void>;
  readServerCoreTypes(): ReturnType<ServerCoreSourceClientService["listTypes"]>;
  readServerCoreVersions(
    serverType: string,
  ): ReturnType<ServerCoreSourceClientService["listVersions"]>;
  readServerCoreArtifacts(
    serverType: string,
    gameVersion: string,
  ): ReturnType<ServerCoreSourceClientService["listArtifacts"]>;
  readServerModFilters(
    resourceType: ServerModrinthResourceType,
    source: ServerModSource,
  ): ReturnType<ServerModSourceClientService["getFilters"]>;
  searchServerMods(
    request: ServerModSearchRequest,
  ): ReturnType<ServerModSourceClientService["search"]>;
  readServerModProjectDetails(
    resourceType: ServerModrinthResourceType,
    source: ServerModSource,
    projectId: string,
  ): ReturnType<ServerModSourceClientService["getProjectDetails"]>;
  installServerMod(request: StartDesktopServerModInstallRequest): Promise<ServerModDownloadResult>;
  saveServerMod(request: StartDesktopServerModSaveRequest): Promise<ServerModDownloadResult>;
  resolveServerCoreIconPath(sha256: string): Promise<string | undefined>;
  resolveServerInstanceIconPath(instanceId: string): Promise<string | undefined>;
  readServerSettings(): ReturnType<ServerSettingsClientService["get"]>;
  writeResourceDownloadDirectory(
    directory: string,
  ): ReturnType<ServerSettingsClientService["setResourceDownloadDirectory"]>;
  writeDefaultDownloadConnections(
    connections: number,
  ): ReturnType<ServerSettingsClientService["setDefaultDownloadConnections"]>;
  writeServerStartupDefaults(
    update: ServerStartupDefaultsUpdate,
  ): ReturnType<ServerSettingsClientService["setStartupDefaults"]>;
  startServerCoreDownload(
    request: StartDesktopServerCoreDownloadRequest,
  ): Promise<ServerCoreDownloadTaskSnapshot>;
  startManagedServerCoreDownload(
    request: StartDesktopManagedServerCoreDownloadRequest,
  ): Promise<ServerCoreManagedDownloadResult>;
  listServerInstances(): ReturnType<ServerInstanceClientService["list"]>;
  readServerInstanceContentCounts(
    instanceId: string,
  ): ReturnType<ServerInstanceClientService["contentCounts"]>;
  listServerMods(instanceId: string): Promise<readonly ServerInstalledModSnapshot[]>;
  setServerModDisabled(
    instanceId: string,
    relativePath: string,
    disabled: boolean,
  ): ReturnType<ServerInstanceClientService["setModDisabled"]>;
  deleteServerMod(
    instanceId: string,
    relativePath: string,
  ): ReturnType<ServerInstanceClientService["deleteMod"]>;
  readServerWorldStorage(instanceId: string): Promise<ServerWorldStorageSnapshot>;
  listServerWorldDatapacks(
    instanceId: string,
    worldId: string,
  ): Promise<readonly ServerWorldDatapackSnapshot[]>;
  setServerWorldDatapackDisabled(
    instanceId: string,
    worldId: string,
    fileName: string,
    disabled: boolean,
  ): ReturnType<ServerInstanceClientService["setWorldDatapackDisabled"]>;
  deleteServerWorldDatapack(
    instanceId: string,
    worldId: string,
    fileName: string,
  ): ReturnType<ServerInstanceClientService["deleteWorldDatapack"]>;
  listServerWorldBackups(
    instanceId: string,
    worldId: string,
  ): Promise<readonly ServerWorldBackupSnapshot[]>;
  createServerWorldBackup(
    instanceId: string,
    worldId: string,
  ): ReturnType<ServerInstanceClientService["createWorldBackup"]>;
  restoreServerWorldBackup(
    instanceId: string,
    worldId: string,
    fileName: string,
  ): ReturnType<ServerInstanceClientService["restoreWorldBackup"]>;
  deleteServerWorldBackup(
    instanceId: string,
    worldId: string,
    fileName: string,
  ): ReturnType<ServerInstanceClientService["deleteWorldBackup"]>;
  switchServerWorld(instanceId: string, worldId: string): Promise<ServerWorldStorageSnapshot>;
  writeServerInstanceStartupSettings(
    instanceId: string,
    settings: ServerInstanceStartupSettings,
  ): Promise<ServerInstanceSnapshot>;
  writeServerInstanceIcon(instanceId: string, iconDataUrl: string): Promise<ServerInstanceSnapshot>;
  deleteServerInstance(instanceId: string): ReturnType<ServerInstanceClientService["delete"]>;
  listServerConfigurations(instanceId: string): Promise<ServerConfigurationCatalog>;
  readServerConfiguration(instanceId: string, path: string): Promise<ServerConfigurationDocument>;
  writeServerConfiguration(
    request: ServerConfigurationWriteRequest,
  ): Promise<ServerConfigurationDocument>;
  previewServerRuntime(
    instanceId: string,
    startupSettings?: ServerInstanceStartupSettings,
  ): ReturnType<ServerRuntimeClientService["preview"]>;
  readServerRuntime(instanceId: string): ReturnType<ServerRuntimeClientService["get"]>;
  startServerRuntime(instanceId: string): ReturnType<ServerRuntimeClientService["start"]>;
  stopServerRuntime(instanceId: string): ReturnType<ServerRuntimeClientService["stop"]>;
  waitUntilServerStartupSettled(
    instanceId: string,
    timeoutMs: number,
  ): ReturnType<ServerRuntimeClientService["waitUntilStartupSettled"]>;
  waitUntilServerStopped(
    instanceId: string,
    timeoutMs: number,
  ): ReturnType<ServerRuntimeClientService["waitUntilStopped"]>;
  sendServerCommand(
    instanceId: string,
    command: string,
  ): ReturnType<ServerRuntimeClientService["sendCommand"]>;
  readServerConsoleLines(
    instanceId: string,
    afterSequence: number,
  ): ReturnType<ServerRuntimeClientService["getLogs"]>;
  scanJavaInstallations(): ReturnType<JavaRuntimeManagerService["scan"]>;
  inspectJavaInstallation(executablePath: string): ReturnType<JavaRuntimeManagerService["inspect"]>;
  removeJavaInstallation(executablePath: string): ReturnType<JavaRuntimeManagerService["remove"]>;
  setJavaInstallationDisabled(
    installationId: string,
    disabled: boolean,
  ): ReturnType<JavaRuntimeManagerService["setDisabled"]>;
  listFileDownloadTasks(): Promise<readonly FileDownloadTaskSnapshot[]>;
  cancelFileDownload(taskId: string): ReturnType<FileDownloadClientService["cancel"]>;
  listServerCoreDownloadTasks(): ReturnType<ServerCoreDownloadClientService["listTasks"]>;
  cancelServerCoreDownload(taskId: string): ReturnType<ServerCoreDownloadClientService["cancel"]>;
  resolveClientPluginAssetPath(requestUrl: string): Promise<string | undefined>;
  readClientEntryPublication(): ClientEntryPublication;
  onClientEntriesChanged(listener: (publication: ClientEntryPublication) => void): () => void;
  callClientService(request: ClientServiceCallRequest): Promise<JsonValue | void>;
  onServerConsoleLine(listener: (line: ServerConsoleLine) => void): () => void;
}
