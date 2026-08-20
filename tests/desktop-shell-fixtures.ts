import {
  desktopShellContract,
  runtimeDiagnosticsContract,
  type ClientEntryPublication,
  type DesktopShellService,
  type FileDownloadTaskSnapshot,
  type JavaInstallationSnapshot,
  type RuntimeDiagnosticsService,
  type RuntimeSnapshot,
  type ServerCoreArtifact,
  type ServerCoreDownloadTaskSnapshot,
  type ServerModDownloadResult,
  type ServerModFilters,
  type ServerModProjectDetails,
  type ServerModSearchRequest,
  type ServerModSearchResult,
  type ServerConfigurationCatalog,
  type ServerConfigurationDocument,
  type ServerConfigurationWriteRequest,
  type ServerConsoleLine,
  type ServerInstanceContentCounts,
  type ServerInstanceStartupSettings,
  type ServerInstanceSnapshot,
  type ServerLaunchCommandPreview,
  type ServerCoreType,
  type ServerRuntimeSnapshot,
  type ServerSettingsSnapshot,
  type ServerStartupDefaultsUpdate,
} from "../packages/contracts/src/index.ts";
import {
  createDesktopShellModule,
  type DesktopShellConfig,
  type DesktopShellRuntime,
  type FileSelectionOptions,
  type DirectorySelectionOptions,
  type StartDesktopServerCoreDownloadRequest,
  type StartDesktopServerModInstallRequest,
  type StartDesktopServerModSaveRequest,
  type StartDesktopManagedServerCoreDownloadRequest,
} from "../components/desktop/shell/src/index.ts";
import type {
  Disposable,
  PluginContext,
  ServiceProvider,
} from "../packages/plugin-sdk/src/index.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMainInvokeEvent } from "electron";

export class FakeBrowserWindow extends EventEmitter {
  readonly webContents: {
    readonly id: number;
    send: (channel: string, payload: unknown) => void;
    setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => void;
    readonly session: {
      setPermissionRequestHandler: (
        handler: (
          contents: unknown,
          permission: string,
          callback: (allowed: boolean) => void,
        ) => void,
      ) => void;
    };
  };
  loadedFile?: string;
  loadedUrl?: string;
  shown = false;
  destroyed = false;
  minimized = false;
  maximized = false;
  closeCount = 0;
  windowOpenHandler?: (details: { url: string }) => unknown;
  permissionRequestHandler?: (
    contents: unknown,
    permission: string,
    callback: (allowed: boolean) => void,
  ) => void;
  readonly sent: Array<{ channel: string; payload: unknown }> = [];

  constructor(
    id: number,
    readonly options: BrowserWindowConstructorOptions,
  ) {
    super();
    this.webContents = {
      id,
      send: (channel, payload) => {
        this.sent.push({ channel, payload });
      },
      setWindowOpenHandler: (handler) => {
        this.windowOpenHandler = handler;
      },
      session: {
        setPermissionRequestHandler: (handler) => {
          this.permissionRequestHandler = handler;
        },
      },
    };
  }

  async loadFile(path: string): Promise<void> {
    this.loadedFile = path;
  }

  async loadURL(url: string): Promise<void> {
    this.loadedUrl = url;
  }

  show(): void {
    this.shown = true;
  }

  minimize(): void {
    this.minimized = true;
  }

  maximize(): void {
    this.maximized = true;
  }

  unmaximize(): void {
    this.maximized = false;
  }

  isMaximized(): boolean {
    return this.maximized;
  }

  close(): void {
    this.closeCount += 1;
    this.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

export class FakeDesktopShellRuntime extends EventEmitter implements DesktopShellRuntime {
  readonly windows: FakeBrowserWindow[] = [];
  readonly handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  readonly protocolHandlers = new Map<
    string,
    (requestUrl: string) => Promise<string | undefined>
  >();
  quitCount = 0;
  directorySelection: string | undefined = "C:/SeaShard/resources";
  directorySelectionWindow?: BrowserWindow;
  directorySelectionOptions?: DirectorySelectionOptions;
  fileSelection: string | undefined = "D:/Java/bin/java.exe";
  fileSelectionWindow?: BrowserWindow;
  fileSelectionOptions?: FileSelectionOptions;
  readonly openedPaths: string[] = [];
  readonly openedExternalUrls: string[] = [];
  openPathResult = "";

  constructor(readonly platform: NodeJS.Platform) {
    super();
  }

  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow {
    const window = new FakeBrowserWindow(this.windows.length + 1, options);
    this.windows.push(window);
    return window as unknown as BrowserWindow;
  }

  getWindowCount(): number {
    return this.windows.filter((window) => !window.destroyed).length;
  }

  onActivate(listener: () => void): void {
    this.on("activate", listener);
  }

  offActivate(listener: () => void): void {
    this.off("activate", listener);
  }

  onWindowAllClosed(listener: () => void): void {
    this.on("window-all-closed", listener);
  }

  offWindowAllClosed(listener: () => void): void {
    this.off("window-all-closed", listener);
  }

  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  handleFileProtocol(
    scheme: string,
    resolvePath: (requestUrl: string) => Promise<string | undefined>,
  ): void {
    if (this.protocolHandlers.has(scheme)) throw new Error(`duplicate protocol: ${scheme}`);
    this.protocolHandlers.set(scheme, resolvePath);
  }

  removeProtocolHandler(scheme: string): void {
    this.protocolHandlers.delete(scheme);
  }

  async resolveProtocol(scheme: string, requestUrl: string): Promise<string | undefined> {
    const handler = this.protocolHandlers.get(scheme);
    if (!handler) throw new Error(`missing protocol: ${scheme}`);
    return handler(requestUrl);
  }

  async invoke(channel: string, senderId: number, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return handler({ sender: { id: senderId } } as IpcMainInvokeEvent, ...args);
  }

  async openPath(path: string): Promise<string> {
    this.openedPaths.push(path);
    return this.openPathResult;
  }
  async openExternal(url: string): Promise<void> {
    this.openedExternalUrls.push(url);
  }

  async selectDirectory(
    window: BrowserWindow,
    options: DirectorySelectionOptions,
  ): Promise<string | undefined> {
    this.directorySelectionWindow = window;
    this.directorySelectionOptions = options;
    return this.directorySelection;
  }

  async selectFile(
    window: BrowserWindow,
    options: FileSelectionOptions,
  ): Promise<string | undefined> {
    this.fileSelectionWindow = window;
    this.fileSelectionOptions = options;
    return this.fileSelection;
  }

  quit(): void {
    this.quitCount += 1;
  }
}

export async function activateDesktopShell(
  config: DesktopShellConfig,
  diagnostics: RuntimeDiagnosticsService,
): Promise<{ service: DesktopShellService; dispose: () => Promise<void> }> {
  const providers = new Map<string, ServiceProvider>([
    [runtimeDiagnosticsContract, diagnostics as unknown as ServiceProvider],
  ]);
  const disposers: Disposable[] = [];
  const context = {
    provide(contract: string, provider: ServiceProvider) {
      providers.set(contract, provider);
    },
    service(contract: string) {
      const provider = providers.get(contract);
      if (!provider) throw new Error(`missing service: ${contract}`);
      return provider;
    },
    effect(execute: () => void | Disposable | Promise<void | Disposable>) {
      const result = execute();
      if (result instanceof Promise) throw new Error("test harness requires synchronous effects");
      if (result) disposers.push(result);
    },
  } as unknown as PluginContext;

  await createDesktopShellModule(config).apply(context, null);
  const service = providers.get(desktopShellContract);
  assert.ok(service, "desktop shell must publish its service");

  return {
    service: service as unknown as DesktopShellService,
    dispose: async () => {
      for (const disposer of disposers.reverse()) await disposer();
    },
  };
}

export const snapshot: RuntimeSnapshot = {
  protocolVersion: 1,
  host: "electron",
  state: "active",
  startedAt: "2026-08-16T00:00:00.000Z",
  components: [],
};

export const clientEntries: ClientEntryPublication = {
  revision: 1,
  entries: [
    {
      runtimeId: "core.runtime-diagnostics.ui",
      pluginId: "seashard.runtime-diagnostics-ui",
      pluginVersion: "0.0.0",
      entryId: "runtime-diagnostics.client",
      moduleKey: "seashard.runtime-diagnostics-ui/runtime-diagnostics.client",
      integrity: "a".repeat(64),
      scopeType: "global",
      scopeId: "global",
      config: null,
    },
  ],
};

export const paperArtifact = {
  source: "cnb",
  serverType: "paper",
  gameVersion: "1.21.1",
  fileName: "paper-1.21.1-131.jar",
  url: "https://example.invalid/paper.jar?sha256=aaaaaaaa",
  sha256: "a".repeat(64),
} satisfies ServerCoreArtifact;

export const paperIconHash = "f".repeat(64);
export const paperIconPath = `C:/SeaShard/core/cache/server-core-icons/${paperIconHash}.png`;
export const paperInstanceIconPath =
  "C:/SeaShard/core/servers/instance-paper/.server-info/icon.png";
export const serverCoreTypes = [
  { id: "vanilla" },
  {
    id: "paper",
    iconUrl: `seashard-cache://server-core-icon/${paperIconHash}`,
  },
] satisfies readonly ServerCoreType[];

export const serverModFilters = {
  sources: [{ id: "modrinth", label: "Modrinth" }],
  tags: [{ id: "utility", label: "实用工具" }],
  versions: [{ id: "1.21.1", label: "1.21.1" }],
  loaders: [{ id: "fabric", label: "Fabric" }],
} satisfies ServerModFilters;

export const serverModSearchRequest = {
  resourceType: "mod",
  source: "modrinth",
  query: "server tools",
  tag: "utility",
  index: "downloads",
  gameVersion: "1.21.1",
  loader: "fabric",
  offset: 0,
  limit: 20,
} satisfies ServerModSearchRequest;

export const serverModSearchResult = {
  items: [
    {
      resourceType: "mod",
      source: "modrinth",
      id: "server-mod-1",
      slug: "server-tools",
      title: "Server Tools",
      description: "Utilities for dedicated servers.",
      author: "SeaLantern",
      downloads: 12_345,
      follows: 678,
      dateModified: "2026-08-17T10:00:00Z",
      environment: ["server_only"],
      categories: ["fabric", "utility"],
      versions: ["1.21.1"],
    },
  ],
  offset: 0,
  limit: 20,
  total: 1,
} satisfies ServerModSearchResult;
export const serverModProjectDetails = {
  resourceType: "mod",
  projectId: "server-mod-1",
  body: "Complete project description.\n\nSecond paragraph.",
  versions: [
    {
      id: "version-neoforge-1",
      gameVersions: ["1.21.1"],
      loaders: ["neoforge"],
      fileName: "server-tools-neoforge-1.21.1.jar",
      downloads: 4_321,
      datePublished: "2026-08-17T11:00:00Z",
    },
  ],
} satisfies ServerModProjectDetails;

export const serverInstances = [
  {
    id: "instance-paper",
    name: "1.21.1-paper",
    rootPath: "C:/SeaShard/core/servers/instance-paper",
    coreJarPath: "C:/SeaShard/core/servers/instance-paper/server.jar",
    iconPath: paperInstanceIconPath,
    storageMode: "managed",
    source: "downloaded",
    modLoader: null,
    serverType: "paper",
    gameVersion: "1.21.1",
    coreArtifactFileName: paperArtifact.fileName,
    artifactSha256: "a".repeat(64),
    createdAt: "2026-08-17T12:00:00.000Z",
    updatedAt: "2026-08-17T12:00:01.000Z",
    totalRuntimeMs: 3_600_000,
  },
] satisfies readonly ServerInstanceSnapshot[];

export const serverInstanceContentCounts = {
  mods: 3,
  plugins: 5,
} satisfies ServerInstanceContentCounts;

export const serverInstanceStartupSettings = {
  minimumMemoryMiB: 1_536,
  maximumMemoryMiB: 4_096,
  serverPort: 25_570,
  autoAcceptEula: false,
  jvmArguments: "-XX:+UseG1GC",
} satisfies ServerInstanceStartupSettings;

export const serverConfigurationCatalog = {
  instanceId: "instance-paper",
  configurationRootPath: "C:/SeaShard/servers/instance-paper",
  serverType: "paper",
  pluginSupported: true,
  serverFiles: [
    {
      path: "server.properties",
      name: "server.properties",
      kind: "properties",
      scope: "server",
    },
  ],
  otherFiles: [],
  plugins: [],
} satisfies ServerConfigurationCatalog;

export const initialServerConfigurationDocument = {
  ...serverConfigurationCatalog.serverFiles[0]!,
  instanceId: "instance-paper",
  content: "motd=SeaShard\n",
  revision: "b".repeat(64),
  encoding: "utf-8",
  modifiedAt: "2026-08-17T12:00:01.000Z",
} satisfies ServerConfigurationDocument;

export const stoppedServerRuntime = {
  instanceId: "instance-paper",
  state: "stopped",
} satisfies ServerRuntimeSnapshot;

export const serverConsoleLine = {
  sequence: 1,
  instanceId: "instance-paper",
  stream: "stdout",
  text: "[Server thread/INFO]: Done",
  timestamp: "2026-08-17T12:00:02.000Z",
} satisfies ServerConsoleLine;

export const javaInstallations = [
  {
    id: "0123456789abcdef",
    path: "C:/Program Files/Eclipse Adoptium/jdk-21/bin/java.exe",
    javaHome: "C:/Program Files/Eclipse Adoptium/jdk-21",
    version: "21.0.7",
    majorVersion: 21,
    vendor: "Eclipse Adoptium",
    architecture: "x64",
    is64Bit: true,
    source: "registry",
    disabled: false,
  },
] satisfies readonly JavaInstallationSnapshot[];

export const manuallyAddedJavaInstallation = {
  ...javaInstallations[0]!,
  id: "fedcba9876543210",
  path: "D:/Java/bin/java.exe",
  javaHome: "D:/Java",
  source: "manual",
} satisfies JavaInstallationSnapshot;

export const defaultServerStartupSettings = {
  defaultMinimumMemoryMiB: 512,
  defaultMaximumMemoryMiB: 2_048,
  defaultServerPort: 25_565,
  autoAcceptEula: true,
  defaultJvmArguments: "",
} satisfies ServerStartupDefaultsUpdate;

export const updatedServerStartupSettings = {
  defaultMinimumMemoryMiB: 1_024,
  defaultMaximumMemoryMiB: 6_144,
  defaultServerPort: 25_566,
  autoAcceptEula: false,
  defaultJvmArguments: "-XX:+UseG1GC",
} satisfies ServerStartupDefaultsUpdate;

export async function createDesktopShellHarness(
  platform: NodeJS.Platform = "win32",
  smokeMode = false,
) {
  const runtime = new FakeDesktopShellRuntime(platform);
  const failures: unknown[] = [];
  const readySnapshots: RuntimeSnapshot[] = [];
  let clientEntryListener: ((publication: ClientEntryPublication) => void) | undefined;
  let serverSettings: ServerSettingsSnapshot = {
    resourceDownloadDirectory: "C:/SeaShard/resources",
    defaultDownloadConnections: 16,
    ...defaultServerStartupSettings,
  };
  const startedDownloads: StartDesktopServerCoreDownloadRequest[] = [];
  const startedManagedDownloads: StartDesktopManagedServerCoreDownloadRequest[] = [];
  const deletedServerInstances: string[] = [];
  let currentServerInstances: readonly ServerInstanceSnapshot[] = serverInstances;
  const serverInstanceStartupWrites: Array<{
    instanceId: string;
    settings: ServerInstanceStartupSettings;
  }> = [];
  let downloadTasks: ServerCoreDownloadTaskSnapshot[] = [];
  let fileDownloadTasks: FileDownloadTaskSnapshot[] = [
    {
      id: "mod-task-1",
      destinationPath: "C:/SeaShard/resources/server-tools-neoforge-1.21.1.jar",
      state: "downloading",
      downloadedBytes: 512,
      totalBytes: 1_024,
      connections: 16,
      progress: 50,
      createdAt: "2026-08-17T12:00:00.000Z",
    },
  ];
  const runtimePreviewRequests: Array<{
    instanceId: string;
    startupSettings?: ServerInstanceStartupSettings;
  }> = [];
  const serverModSearchRequests: ServerModSearchRequest[] = [];
  const serverModDetailProjectIds: string[] = [];
  const installedServerMods: StartDesktopServerModInstallRequest[] = [];
  const savedServerMods: StartDesktopServerModSaveRequest[] = [];
  let serverRuntime: ServerRuntimeSnapshot = stoppedServerRuntime;
  const serverCommands: string[] = [];
  let serverConsoleListener: ((line: ServerConsoleLine) => void) | undefined;
  let serverConfigurationDocument = initialServerConfigurationDocument;
  const configurationWrites: ServerConfigurationWriteRequest[] = [];
  const inspectedJavaPaths: string[] = [];
  const removedJavaPaths: string[] = [];
  const javaDisabledUpdates: Array<{ installationId: string; disabled: boolean }> = [];
  const saveAsRequest = {
    serverType: "paper",
    gameVersion: "1.21.1",
    artifactFileName: paperArtifact.fileName,
    destinationFileName: "custom-paper.jar",
  } as const;
  const shell = await activateDesktopShell(
    {
      runtime,
      preloadPath: "C:/SeaShard/preload.cjs",
      rendererFile: "C:/SeaShard/index.html",
      smokeMode,
      reportOpenFailure: (error) => failures.push(error),
      onRendererReady: (value) => {
        readySnapshots.push(value);
      },
      readClientEntryPublication: () => clientEntries,
      readServerCoreTypes: async () => serverCoreTypes,
      readServerCoreVersions: async (serverType) => (serverType === "paper" ? ["1.21.1"] : []),
      readServerCoreArtifacts: async (serverType, gameVersion) =>
        serverType === "paper" && gameVersion === "1.21.1" ? [paperArtifact] : [],
      readServerModFilters: async () => serverModFilters,
      searchServerMods: async (request) => {
        serverModSearchRequests.push(request);
        return serverModSearchResult;
      },
      readServerModProjectDetails: async (_resourceType, projectId) => {
        serverModDetailProjectIds.push(projectId);
        return serverModProjectDetails;
      },
      installServerMod: async (request) => {
        installedServerMods.push(request);
        return {
          resourceType: request.resourceType,
          projectId: request.projectId,
          versionId: request.versionId,
          fileName: "server-tools-neoforge-1.21.1.jar",
          destination: "instance",
          instanceId: request.instanceId,
          downloadedBytes: 1_024,
        } satisfies ServerModDownloadResult;
      },
      saveServerMod: async (request) => {
        savedServerMods.push(request);
        return {
          resourceType: request.resourceType,
          projectId: request.projectId,
          versionId: request.versionId,
          fileName: "server-tools-neoforge-1.21.1.jar",
          destination: "directory",
          downloadedBytes: 1_024,
        } satisfies ServerModDownloadResult;
      },
      resolveServerCoreIconPath: async (sha256) =>
        sha256 === paperIconHash ? paperIconPath : undefined,
      resolveServerInstanceIconPath: async (instanceId) =>
        instanceId === "instance-paper" ? paperInstanceIconPath : undefined,
      readServerSettings: async () => serverSettings,
      writeResourceDownloadDirectory: async (directory) => {
        serverSettings = { ...serverSettings, resourceDownloadDirectory: directory };
        return serverSettings;
      },
      writeDefaultDownloadConnections: async (connections) => {
        serverSettings = { ...serverSettings, defaultDownloadConnections: connections };
        return serverSettings;
      },
      writeServerStartupDefaults: async (update) => {
        serverSettings = { ...serverSettings, ...update };
        return serverSettings;
      },
      startServerCoreDownload: async (request) => {
        startedDownloads.push(request);
        const task: ServerCoreDownloadTaskSnapshot = {
          id: `task-${startedDownloads.length}`,
          artifact: paperArtifact,
          destinationPath: `${request.destinationDirectory}/${request.destinationFileName}`,
          state: "queued",
          downloadedBytes: 0,
          totalBytes: 0,
          connections: 0,
          progress: 0,
          createdAt: "2026-08-17T12:00:00.000Z",
        };
        downloadTasks = [...downloadTasks, task];
        return task;
      },
      startManagedServerCoreDownload: async (request) => {
        startedManagedDownloads.push(request);
        const task: ServerCoreDownloadTaskSnapshot = {
          id: `managed-task-${startedManagedDownloads.length}`,
          artifact: paperArtifact,
          destinationPath: `C:/SeaShard/core/servers/managed-${startedManagedDownloads.length}/${request.destinationFileName}`,
          state: "queued",
          downloadedBytes: 0,
          totalBytes: 0,
          connections: request.connections,
          progress: 0,
          createdAt: "2026-08-17T12:00:00.000Z",
        };
        downloadTasks = [...downloadTasks, task];
        return { instanceId: "instance-managed", task };
      },
      listServerInstances: async () => currentServerInstances,
      readServerInstanceContentCounts: async () => serverInstanceContentCounts,
      writeServerInstanceStartupSettings: async (instanceId, settings) => {
        serverInstanceStartupWrites.push({ instanceId, settings });
        const instance = currentServerInstances.find((candidate) => candidate.id === instanceId);
        if (!instance) throw new Error(`server instance ${instanceId} was not found`);
        const updated: ServerInstanceSnapshot = {
          ...instance,
          startupSettings: settings,
          updatedAt: "2026-08-17T12:00:02.000Z",
        };
        currentServerInstances = currentServerInstances.map((candidate) =>
          candidate.id === instanceId ? updated : candidate,
        );
        return updated;
      },
      deleteServerInstance: async (instanceId) => {
        deletedServerInstances.push(instanceId);
      },
      listServerConfigurations: async () => serverConfigurationCatalog,
      readServerConfiguration: async () => serverConfigurationDocument,
      writeServerConfiguration: async (request) => {
        configurationWrites.push(request);
        serverConfigurationDocument = {
          ...serverConfigurationDocument,
          content: request.content,
          revision: "c".repeat(64),
          modifiedAt: "2026-08-17T12:00:02.000Z",
        };
        return serverConfigurationDocument;
      },
      previewServerRuntime: async (instanceId, startupSettings) => {
        runtimePreviewRequests.push({
          instanceId,
          ...(startupSettings ? { startupSettings } : {}),
        });
        const effective = startupSettings ?? serverInstanceStartupSettings;
        return {
          instanceId,
          command: [
            `"${javaInstallations[0]!.path}"`,
            effective.jvmArguments,
            `-Xms${effective.minimumMemoryMiB}M`,
            `-Xmx${effective.maximumMemoryMiB}M`,
            "-jar",
            "server.jar",
            "nogui",
          ]
            .filter(Boolean)
            .join(" "),
        } satisfies ServerLaunchCommandPreview;
      },
      readServerRuntime: async () => serverRuntime,
      startServerRuntime: async (instanceId) => {
        serverRuntime = {
          instanceId,
          state: "running",
          pid: 4_242,
          startedAt: "2026-08-17T12:00:02.000Z",
        };
        return serverRuntime;
      },
      stopServerRuntime: async (instanceId) => {
        serverRuntime = {
          instanceId,
          state: "stopped",
          stoppedAt: "2026-08-17T12:00:03.000Z",
          exitCode: 0,
        };
        return serverRuntime;
      },
      sendServerCommand: async (_instanceId, command) => {
        serverCommands.push(command);
      },
      readServerConsoleLines: async (_instanceId, afterSequence) =>
        serverConsoleLine.sequence > afterSequence ? [serverConsoleLine] : [],
      scanJavaInstallations: async () => javaInstallations,
      inspectJavaInstallation: async (executablePath) => {
        inspectedJavaPaths.push(executablePath);
        return manuallyAddedJavaInstallation;
      },
      removeJavaInstallation: async (executablePath) => {
        removedJavaPaths.push(executablePath);
        return true;
      },
      setJavaInstallationDisabled: async (installationId, disabled) => {
        javaDisabledUpdates.push({ installationId, disabled });
        return disabled;
      },
      listFileDownloadTasks: async () => fileDownloadTasks,
      cancelFileDownload: async (taskId) => {
        const task = fileDownloadTasks.find((candidate) => candidate.id === taskId);
        if (!task || ["completed", "failed", "cancelled"].includes(task.state)) return false;
        fileDownloadTasks = fileDownloadTasks.map((candidate) =>
          candidate.id === taskId
            ? {
                ...candidate,
                state: "cancelled",
                finishedAt: "2026-08-17T12:00:01.000Z",
                error: "download cancelled",
              }
            : candidate,
        );
        return true;
      },
      listServerCoreDownloadTasks: async () => downloadTasks,
      cancelServerCoreDownload: async (taskId) => {
        const task = downloadTasks.find((candidate) => candidate.id === taskId);
        if (!task || ["completed", "failed", "cancelled"].includes(task.state)) return false;
        downloadTasks = downloadTasks.map((candidate) =>
          candidate.id === taskId
            ? {
                ...candidate,
                state: "cancelled",
                finishedAt: "2026-08-17T12:00:01.000Z",
                error: "download cancelled",
              }
            : candidate,
        );
        return true;
      },
      onClientEntriesChanged: (listener) => {
        clientEntryListener = listener;
        return () => {
          if (clientEntryListener === listener) clientEntryListener = undefined;
        };
      },
      onServerConsoleLine: (listener) => {
        serverConsoleListener = listener;
        return () => {
          if (serverConsoleListener === listener) serverConsoleListener = undefined;
        };
      },
    },
    { getSnapshot: async () => snapshot },
  );

  return {
    runtime,
    shell,
    failures,
    readySnapshots,
    startedDownloads,
    startedManagedDownloads,
    deletedServerInstances,
    serverInstanceStartupWrites,
    serverModSearchRequests,
    serverModDetailProjectIds,
    installedServerMods,
    savedServerMods,
    serverCommands,
    configurationWrites,
    inspectedJavaPaths,
    runtimePreviewRequests,
    removedJavaPaths,
    javaDisabledUpdates,
    saveAsRequest,
    get serverSettings() {
      return serverSettings;
    },
    get downloadTasks() {
      return downloadTasks;
    },
    get fileDownloadTasks() {
      return fileDownloadTasks;
    },
    get serverRuntime() {
      return serverRuntime;
    },
    get serverConfigurationDocument() {
      return serverConfigurationDocument;
    },
    get clientEntryListener() {
      return clientEntryListener;
    },
    get serverConsoleListener() {
      return serverConsoleListener;
    },
  };
}
