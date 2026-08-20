import type {
  ClientEntryPublication,
  JavaRuntimeManagerService,
  RuntimeSnapshot,
  ServerCoreDownloadClientService,
  ServerCoreDownloadTaskSnapshot,
  ServerCoreManagedDownloadResult,
  ServerCoreManagedDownloadRequest,
  ServerCoreSaveAsRequest,
  ServerCoreSourceClientService,
  ServerInstanceClientService,
  ServerConsoleLine,
  ServerRuntimeClientService,
  ServerConfigurationCatalog,
  ServerConfigurationDocument,
  ServerConfigurationWriteRequest,
  ServerSettingsClientService,
  ServerStartupDefaultsUpdate,
} from "@seashard/contracts";
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
  deleteServerInstance(instanceId: string): ReturnType<ServerInstanceClientService["delete"]>;
  listServerConfigurations(instanceId: string): Promise<ServerConfigurationCatalog>;
  readServerConfiguration(instanceId: string, path: string): Promise<ServerConfigurationDocument>;
  writeServerConfiguration(
    request: ServerConfigurationWriteRequest,
  ): Promise<ServerConfigurationDocument>;
  readServerRuntime(instanceId: string): ReturnType<ServerRuntimeClientService["get"]>;
  startServerRuntime(instanceId: string): ReturnType<ServerRuntimeClientService["start"]>;
  stopServerRuntime(instanceId: string): ReturnType<ServerRuntimeClientService["stop"]>;
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
  listServerCoreDownloadTasks(): ReturnType<ServerCoreDownloadClientService["listTasks"]>;
  cancelServerCoreDownload(taskId: string): ReturnType<ServerCoreDownloadClientService["cancel"]>;
  readClientEntryPublication(): ClientEntryPublication;
  onClientEntriesChanged(listener: (publication: ClientEntryPublication) => void): () => void;
  onServerConsoleLine(listener: (line: ServerConsoleLine) => void): () => void;
}
