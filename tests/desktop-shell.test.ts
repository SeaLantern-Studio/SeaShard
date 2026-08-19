import {
  desktopChannels,
  desktopShellContract,
  runtimeDiagnosticsContract,
  serverCoreIconScheme,
  serverInstanceIconHost,
  type ClientEntryPublication,
  type DesktopClientBootstrap,
  type DesktopShellService,
  type JavaInstallationSnapshot,
  type RuntimeDiagnosticsService,
  type RuntimeSnapshot,
  type ServerCoreArtifact,
  type ServerCoreDownloadTaskSnapshot,
  type ServerConsoleLine,
  type ServerConfigurationCatalog,
  type ServerConfigurationDocument,
  type ServerConfigurationWriteRequest,
  type ServerInstanceSnapshot,
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
  type StartDesktopManagedServerCoreDownloadRequest,
} from "../components/desktop/shell/src/index.ts";
import type {
  Disposable,
  PluginContext,
  ServiceProvider,
} from "../packages/plugin-sdk/src/index.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMainInvokeEvent } from "electron";

class FakeBrowserWindow extends EventEmitter {
  readonly webContents: {
    readonly id: number;
    send: (channel: string, payload: unknown) => void;
    setWindowOpenHandler: (handler: () => unknown) => void;
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
  windowOpenHandler?: () => unknown;
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

class FakeDesktopShellRuntime extends EventEmitter implements DesktopShellRuntime {
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

async function activateDesktopShell(
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

const snapshot: RuntimeSnapshot = {
  protocolVersion: 1,
  host: "electron",
  state: "active",
  startedAt: "2026-08-16T00:00:00.000Z",
  components: [],
};

const clientEntries: ClientEntryPublication = {
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

const paperArtifact = {
  source: "cnb",
  serverType: "paper",
  gameVersion: "1.21.1",
  fileName: "paper-1.21.1-131.jar",
  url: "https://example.invalid/paper.jar?sha256=aaaaaaaa",
  sha256: "a".repeat(64),
} satisfies ServerCoreArtifact;

const paperIconHash = "f".repeat(64);
const paperIconPath = `C:/SeaShard/core/cache/server-core-icons/${paperIconHash}.png`;
const paperInstanceIconPath = "C:/SeaShard/core/servers/instance-paper/.server-info/icon.png";
const serverCoreTypes = [
  { id: "vanilla" },
  {
    id: "paper",
    iconUrl: `seashard-cache://server-core-icon/${paperIconHash}`,
  },
] satisfies readonly ServerCoreType[];

const serverInstances = [
  {
    id: "instance-paper",
    name: "1.21.1-paper",
    rootPath: "C:/SeaShard/core/servers/instance-paper",
    coreJarPath: "C:/SeaShard/core/servers/instance-paper/server.jar",
    iconPath: paperInstanceIconPath,
    storageMode: "managed",
    source: "downloaded",
    serverType: "paper",
    gameVersion: "1.21.1",
    coreArtifactFileName: paperArtifact.fileName,
    artifactSha256: "a".repeat(64),
    createdAt: "2026-08-17T12:00:00.000Z",
    updatedAt: "2026-08-17T12:00:01.000Z",
  },
] satisfies readonly ServerInstanceSnapshot[];

const serverConfigurationCatalog = {
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
  plugins: [],
} satisfies ServerConfigurationCatalog;

const initialServerConfigurationDocument = {
  ...serverConfigurationCatalog.serverFiles[0]!,
  instanceId: "instance-paper",
  content: "motd=SeaShard\n",
  revision: "b".repeat(64),
  encoding: "utf-8",
  modifiedAt: "2026-08-17T12:00:01.000Z",
} satisfies ServerConfigurationDocument;

const stoppedServerRuntime = {
  instanceId: "instance-paper",
  state: "stopped",
} satisfies ServerRuntimeSnapshot;

const serverConsoleLine = {
  sequence: 1,
  instanceId: "instance-paper",
  stream: "stdout",
  text: "[Server thread/INFO]: Done",
  timestamp: "2026-08-17T12:00:02.000Z",
} satisfies ServerConsoleLine;

const javaInstallations = [
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
  },
] satisfies readonly JavaInstallationSnapshot[];

const manuallyAddedJavaInstallation = {
  ...javaInstallations[0]!,
  id: "fedcba9876543210",
  path: "D:/Java/bin/java.exe",
  javaHome: "D:/Java",
  source: "manual",
} satisfies JavaInstallationSnapshot;

const defaultServerStartupSettings = {
  defaultMinimumMemoryMiB: 512,
  defaultMaximumMemoryMiB: 2_048,
  defaultServerPort: 25_565,
  autoAcceptEula: true,
  defaultJvmArguments: "",
} satisfies ServerStartupDefaultsUpdate;

const updatedServerStartupSettings = {
  defaultMinimumMemoryMiB: 1_024,
  defaultMaximumMemoryMiB: 6_144,
  defaultServerPort: 25_566,
  autoAcceptEula: false,
  defaultJvmArguments: "-XX:+UseG1GC",
} satisfies ServerStartupDefaultsUpdate;

await test("desktop shell owns window, sender authorization, and IPC as one lifecycle", async () => {
  const runtime = new FakeDesktopShellRuntime("win32");
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
  let downloadTasks: ServerCoreDownloadTaskSnapshot[] = [];
  let serverRuntime: ServerRuntimeSnapshot = stoppedServerRuntime;
  const serverCommands: string[] = [];
  let serverConsoleListener: ((line: ServerConsoleLine) => void) | undefined;
  let serverConfigurationDocument = initialServerConfigurationDocument;
  const configurationWrites: ServerConfigurationWriteRequest[] = [];
  const inspectedJavaPaths: string[] = [];
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
      smokeMode: false,
      reportOpenFailure: (error) => failures.push(error),
      onRendererReady: (value) => {
        readySnapshots.push(value);
      },
      readClientEntryPublication: () => clientEntries,
      readServerCoreTypes: async () => serverCoreTypes,
      readServerCoreVersions: async (serverType) => (serverType === "paper" ? ["1.21.1"] : []),
      readServerCoreArtifacts: async (serverType, gameVersion) =>
        serverType === "paper" && gameVersion === "1.21.1" ? [paperArtifact] : [],
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
      listServerInstances: async () => serverInstances,
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

  assert.equal(runtime.protocolHandlers.has(serverCoreIconScheme), true);
  assert.equal(
    await runtime.resolveProtocol(serverCoreIconScheme, serverCoreTypes[1]!.iconUrl!),
    paperIconPath,
  );
  assert.equal(
    await runtime.resolveProtocol(
      serverCoreIconScheme,
      `${serverCoreIconScheme}://${serverInstanceIconHost}/instance-paper`,
    ),
    paperInstanceIconPath,
  );
  assert.equal(
    await runtime.resolveProtocol(
      serverCoreIconScheme,
      `seashard-cache://other-host/${paperIconHash}`,
    ),
    undefined,
  );

  assert.equal(runtime.handlers.has(desktopChannels.runtimeSnapshot), true);
  await assert.rejects(runtime.invoke(desktopChannels.runtimeSnapshot, 1), /request rejected/);
  assert.equal(runtime.handlers.has(desktopChannels.clientBootstrap), true);
  await assert.rejects(runtime.invoke(desktopChannels.clientBootstrap, 1), /request rejected/);
  assert.equal(runtime.handlers.has(desktopChannels.rendererReady), true);
  await assert.rejects(runtime.invoke(desktopChannels.rendererReady, 1), /request rejected/);
  await assert.rejects(runtime.invoke(desktopChannels.windowMinimize, 1), /request rejected/);
  await assert.rejects(runtime.invoke(desktopChannels.windowToggleMaximize, 1), /request rejected/);
  await assert.rejects(runtime.invoke(desktopChannels.windowClose, 1), /request rejected/);
  await assert.rejects(
    runtime.invoke(desktopChannels.dialogSelectDirectory, 1),
    /request rejected/,
  );
  await assert.rejects(runtime.invoke(desktopChannels.serverSettingsGet, 1), /request rejected/);
  await assert.rejects(
    runtime.invoke(
      desktopChannels.serverSettingsSetResourceDownloadDirectory,
      1,
      "D:/Servers/resources",
    ),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverSettingsSetDefaultDownloadConnections, 1, 4),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(
      desktopChannels.serverSettingsSetStartupDefaults,
      1,
      updatedServerStartupSettings,
    ),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreDownloadSaveAs, 1, saveAsRequest),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreDownloadStartManaged, 1, saveAsRequest),
    /request rejected/,
  );
  await assert.rejects(runtime.invoke(desktopChannels.serverInstancesList, 1), /request rejected/);
  await assert.rejects(
    runtime.invoke(desktopChannels.serverInstancesDelete, 1, "instance-paper"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverConfigurationList, 1, "instance-paper"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(
      desktopChannels.serverConfigurationRead,
      1,
      "instance-paper",
      "server.properties",
    ),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverConfigurationWrite, 1, {
      instanceId: "instance-paper",
      path: "server.properties",
      content: "motd=Rejected\n",
      expectedRevision: "b".repeat(64),
    }),
    /request rejected/,
  );
  await assert.rejects(runtime.invoke(desktopChannels.javaRuntimeScan, 1), /request rejected/);
  await assert.rejects(runtime.invoke(desktopChannels.javaRuntimeAdd, 1), /request rejected/);
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreDownloadListTasks, 1),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreDownloadCancel, 1, "task-1"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverRuntimeGet, 1, "instance-paper"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverRuntimeStart, 1, "instance-paper"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverRuntimeStop, 1, "instance-paper"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverRuntimeSendCommand, 1, "instance-paper", "list"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverRuntimeGetLogs, 1, "instance-paper", 0),
    /request rejected/,
  );

  await Promise.all([shell.service.openPrimary(), shell.service.openPrimary()]);
  assert.equal(runtime.windows.length, 1, "concurrent opens must share one primary window");
  const first = runtime.windows[0];
  assert.equal(first.loadedFile, "C:/SeaShard/index.html");
  assert.equal(first.options.width, 1200);
  assert.equal(first.options.height, 720);
  assert.equal(first.options.minWidth, 1000);
  assert.equal(first.options.minHeight, 625);
  assert.equal(first.options.titleBarStyle, "hidden");
  assert.deepEqual(first.options.webPreferences, {
    preload: "C:/SeaShard/preload.cjs",
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  });
  assert.deepEqual(first.windowOpenHandler?.(), { action: "deny" });
  let permissionAllowed: boolean | undefined;
  first.permissionRequestHandler?.(undefined, "notifications", (allowed) => {
    permissionAllowed = allowed;
  });
  assert.equal(permissionAllowed, false);

  assert.equal(await runtime.invoke(desktopChannels.windowMinimize, 1), undefined);
  assert.equal(first.minimized, true);
  assert.equal(await runtime.invoke(desktopChannels.windowToggleMaximize, 1), true);
  assert.equal(first.maximized, true);
  assert.equal(await runtime.invoke(desktopChannels.windowToggleMaximize, 1), false);
  assert.equal(first.maximized, false);
  assert.equal(
    await runtime.invoke(desktopChannels.dialogSelectDirectory, 1),
    runtime.directorySelection,
  );
  assert.equal(runtime.directorySelectionWindow, first as unknown as BrowserWindow);
  assert.deepEqual(runtime.directorySelectionOptions, {
    title: "选择资源默认下载地址",
    buttonLabel: "选择此文件夹",
    defaultPath: "C:/SeaShard/resources",
  });
  await assert.rejects(
    runtime.invoke(desktopChannels.dialogSelectDirectory, 999),
    /request rejected/,
  );
  assert.deepEqual(await runtime.invoke(desktopChannels.serverSettingsGet, 1), serverSettings);
  assert.deepEqual(
    await runtime.invoke(
      desktopChannels.serverSettingsSetResourceDownloadDirectory,
      1,
      "D:/Servers/resources",
    ),
    {
      resourceDownloadDirectory: "D:/Servers/resources",
      defaultDownloadConnections: 16,
      ...defaultServerStartupSettings,
    },
  );
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverSettingsSetDefaultDownloadConnections, 1, 4),
    {
      resourceDownloadDirectory: "D:/Servers/resources",
      defaultDownloadConnections: 4,
      ...defaultServerStartupSettings,
    },
  );
  assert.deepEqual(
    await runtime.invoke(
      desktopChannels.serverSettingsSetStartupDefaults,
      1,
      updatedServerStartupSettings,
    ),
    {
      resourceDownloadDirectory: "D:/Servers/resources",
      defaultDownloadConnections: 4,
      ...updatedServerStartupSettings,
    },
  );
  assert.deepEqual(serverSettings, {
    resourceDownloadDirectory: "D:/Servers/resources",
    defaultDownloadConnections: 4,
    ...updatedServerStartupSettings,
  });
  await assert.rejects(
    runtime.invoke(desktopChannels.serverSettingsSetResourceDownloadDirectory, 1, 42),
    /must be a string/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverSettingsSetDefaultDownloadConnections, 1, 4.5),
    /must be a safe integer/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverSettingsSetStartupDefaults, 1, {
      ...updatedServerStartupSettings,
      autoAcceptEula: "yes",
    }),
    /must be a boolean/,
  );
  await assert.rejects(runtime.invoke(desktopChannels.serverSettingsGet, 999), /request rejected/);
  await assert.rejects(
    runtime.invoke(desktopChannels.serverSettingsSetResourceDownloadDirectory, 999, "E:/Rejected"),
    /request rejected/,
  );
  await assert.rejects(
    runtime.invoke(
      desktopChannels.serverSettingsSetStartupDefaults,
      999,
      updatedServerStartupSettings,
    ),
    /request rejected/,
  );
  runtime.directorySelection = "D:/Downloads";
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverCoreDownloadSaveAs, 1, saveAsRequest),
    downloadTasks[0],
  );
  assert.deepEqual(runtime.directorySelectionOptions, {
    title: "选择 custom-paper.jar 的保存文件夹",
    buttonLabel: "保存到此文件夹",
    defaultPath: "D:/Servers/resources",
  });
  assert.deepEqual(startedDownloads, [
    {
      ...saveAsRequest,
      destinationDirectory: "D:/Downloads",
      connections: 4,
    },
  ]);
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverCoreDownloadListTasks, 1),
    downloadTasks,
  );
  assert.equal(await runtime.invoke(desktopChannels.serverCoreDownloadCancel, 1, "task-1"), true);
  assert.equal(downloadTasks[0]?.state, "cancelled");
  runtime.directorySelection = undefined;
  assert.equal(
    await runtime.invoke(desktopChannels.serverCoreDownloadSaveAs, 1, saveAsRequest),
    undefined,
  );
  assert.equal(startedDownloads.length, 1, "cancelling the folder dialog must not start a task");
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverCoreDownloadStartManaged, 1, saveAsRequest),
    { instanceId: "instance-managed", task: downloadTasks[1] },
  );
  assert.deepEqual(startedManagedDownloads, [{ ...saveAsRequest, connections: 4 }]);
  assert.deepEqual(await runtime.invoke(desktopChannels.serverInstancesList, 1), serverInstances);
  assert.equal(
    await runtime.invoke(desktopChannels.serverInstancesDelete, 1, "instance-paper"),
    undefined,
  );
  assert.deepEqual(deletedServerInstances, ["instance-paper"]);
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverConfigurationList, 1, "instance-paper"),
    serverConfigurationCatalog,
  );
  assert.deepEqual(
    await runtime.invoke(
      desktopChannels.serverConfigurationRead,
      1,
      "instance-paper",
      "server.properties",
    ),
    initialServerConfigurationDocument,
  );
  const configurationWrite = {
    instanceId: "instance-paper",
    path: "server.properties",
    content: "motd=Updated\n",
    expectedRevision: "b".repeat(64),
  } satisfies ServerConfigurationWriteRequest;
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverConfigurationWrite, 1, configurationWrite),
    serverConfigurationDocument,
  );
  assert.deepEqual(configurationWrites, [configurationWrite]);
  await assert.rejects(
    runtime.invoke(desktopChannels.serverConfigurationWrite, 1, {
      ...configurationWrite,
      content: 42,
    }),
    /must be a string/,
  );
  assert.deepEqual(await runtime.invoke(desktopChannels.javaRuntimeScan, 1), javaInstallations);
  await assert.rejects(runtime.invoke(desktopChannels.javaRuntimeScan, 999), /request rejected/);
  assert.deepEqual(
    await runtime.invoke(desktopChannels.javaRuntimeAdd, 1),
    manuallyAddedJavaInstallation,
  );
  assert.equal(runtime.fileSelectionWindow, first as unknown as BrowserWindow);
  assert.deepEqual(runtime.fileSelectionOptions, {
    title: "选择 Java 可执行文件",
    buttonLabel: "添加此 Java",
    filters: [{ name: "Java 可执行文件", extensions: ["exe"] }],
  });
  assert.deepEqual(inspectedJavaPaths, ["D:/Java/bin/java.exe"]);
  runtime.fileSelection = undefined;
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverRuntimeGet, 1, "instance-paper"),
    stoppedServerRuntime,
  );
  assert.deepEqual(await runtime.invoke(desktopChannels.serverRuntimeStart, 1, "instance-paper"), {
    instanceId: "instance-paper",
    state: "running",
    pid: 4_242,
    startedAt: "2026-08-17T12:00:02.000Z",
  });
  await assert.rejects(
    runtime.invoke(desktopChannels.serverInstancesDelete, 1, "instance-paper"),
    /请先停止服务器/,
  );
  assert.deepEqual(deletedServerInstances, ["instance-paper"]);
  assert.equal(
    await runtime.invoke(desktopChannels.serverRuntimeSendCommand, 1, "instance-paper", "list"),
    undefined,
  );
  assert.deepEqual(serverCommands, ["list"]);
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverRuntimeGetLogs, 1, "instance-paper", 0),
    [serverConsoleLine],
  );
  assert.deepEqual(
    await runtime.invoke(
      desktopChannels.serverRuntimeGetLogs,
      1,
      "instance-paper",
      serverConsoleLine.sequence,
    ),
    [],
  );
  assert.deepEqual(await runtime.invoke(desktopChannels.serverRuntimeStop, 1, "instance-paper"), {
    instanceId: "instance-paper",
    state: "stopped",
    stoppedAt: "2026-08-17T12:00:03.000Z",
    exitCode: 0,
  });
  await assert.rejects(
    runtime.invoke(desktopChannels.serverRuntimeSendCommand, 1, "instance-paper", ""),
    /non-empty string/,
  );
  assert.equal(await runtime.invoke(desktopChannels.javaRuntimeAdd, 1), undefined);
  assert.deepEqual(
    inspectedJavaPaths,
    ["D:/Java/bin/java.exe"],
    "取消文件选择不能调用 Java 检查服务",
  );
  runtime.directorySelection = "C:/SeaShard/resources";
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreDownloadListTasks, 999),
    /request rejected/,
  );
  assert.equal(await runtime.invoke(desktopChannels.runtimeSnapshot, 1), snapshot);
  await assert.rejects(runtime.invoke(desktopChannels.runtimeSnapshot, 999), /request rejected/);
  assert.deepEqual(await runtime.invoke(desktopChannels.serverCoreTypes, 1), serverCoreTypes);
  await assert.rejects(runtime.invoke(desktopChannels.serverCoreTypes, 999), /request rejected/);
  assert.deepEqual(await runtime.invoke(desktopChannels.serverCoreVersions, 1, "paper"), [
    "1.21.1",
  ]);
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreVersions, 1, ""),
    /non-empty string/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreVersions, 999, "paper"),
    /request rejected/,
  );
  assert.deepEqual(
    await runtime.invoke(desktopChannels.serverCoreArtifacts, 1, "paper", "1.21.1"),
    [paperArtifact],
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreArtifacts, 1, "paper", ""),
    /non-empty string/,
  );
  await assert.rejects(
    runtime.invoke(desktopChannels.serverCoreArtifacts, 999, "paper", "1.21.1"),
    /request rejected/,
  );
  assert.deepEqual(readySnapshots, []);
  assert.deepEqual(await runtime.invoke(desktopChannels.clientBootstrap, 1), {
    protocolVersion: 1,
    ...clientEntries,
    clientSession: {
      id: "desktop-primary:1",
      target: "desktop",
      surface: "primary",
    },
  } satisfies DesktopClientBootstrap);
  await assert.rejects(runtime.invoke(desktopChannels.clientBootstrap, 999), /request rejected/);
  assert.equal(await runtime.invoke(desktopChannels.rendererReady, 1), undefined);
  assert.deepEqual(readySnapshots, [snapshot]);
  await assert.rejects(runtime.invoke(desktopChannels.rendererReady, 999), /request rejected/);
  const updatedEntries = { ...clientEntries, revision: 2 };
  clientEntryListener?.(updatedEntries);
  serverConsoleListener?.(serverConsoleLine);
  assert.deepEqual(first.sent, [
    {
      channel: desktopChannels.clientBootstrapChanged,
      payload: {
        protocolVersion: 1,
        ...updatedEntries,
        clientSession: {
          id: "desktop-primary:1",
          target: "desktop",
          surface: "primary",
        },
      },
    },
    {
      channel: desktopChannels.serverRuntimeConsoleLine,
      payload: serverConsoleLine,
    },
  ]);

  first.emit("ready-to-show");
  assert.equal(first.shown, true);
  await runtime.invoke(desktopChannels.windowClose, 1);
  assert.equal(first.closeCount, 1);
  runtime.emit("activate");
  assert.equal(runtime.windows.length, 2, "activate must recreate a closed primary window");

  runtime.emit("window-all-closed");
  assert.equal(runtime.quitCount, 1);
  await shell.dispose();
  assert.equal(runtime.windows[1].destroyed, true);
  assert.equal(runtime.listenerCount("activate"), 0);
  assert.equal(runtime.listenerCount("window-all-closed"), 0);
  assert.equal(runtime.handlers.has(desktopChannels.runtimeSnapshot), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverCoreTypes), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverCoreVersions), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverCoreArtifacts), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverSettingsGet), false);
  assert.equal(
    runtime.handlers.has(desktopChannels.serverSettingsSetResourceDownloadDirectory),
    false,
  );
  assert.equal(
    runtime.handlers.has(desktopChannels.serverSettingsSetDefaultDownloadConnections),
    false,
  );
  assert.equal(runtime.handlers.has(desktopChannels.serverSettingsSetStartupDefaults), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverCoreDownloadSaveAs), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverCoreDownloadStartManaged), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverInstancesList), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverInstancesDelete), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverConfigurationList), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverConfigurationRead), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverConfigurationWrite), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverRuntimeGet), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverRuntimeStart), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverRuntimeStop), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverRuntimeSendCommand), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverRuntimeGetLogs), false);
  assert.equal(runtime.handlers.has(desktopChannels.javaRuntimeScan), false);
  assert.equal(runtime.handlers.has(desktopChannels.javaRuntimeAdd), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverCoreDownloadListTasks), false);
  assert.equal(runtime.handlers.has(desktopChannels.serverCoreDownloadCancel), false);
  assert.equal(runtime.handlers.has(desktopChannels.clientBootstrap), false);
  assert.equal(runtime.handlers.has(desktopChannels.rendererReady), false);
  assert.equal(runtime.handlers.has(desktopChannels.windowMinimize), false);
  assert.equal(runtime.handlers.has(desktopChannels.windowToggleMaximize), false);
  assert.equal(runtime.handlers.has(desktopChannels.windowClose), false);
  assert.equal(runtime.handlers.has(desktopChannels.dialogSelectDirectory), false);
  assert.equal(clientEntryListener, undefined);
  assert.equal(serverConsoleListener, undefined);
  assert.equal(runtime.protocolHandlers.has(serverCoreIconScheme), false);
  assert.deepEqual(failures, []);
});

await test("desktop shell keeps macOS alive after the last window closes", async () => {
  const runtime = new FakeDesktopShellRuntime("darwin");
  const shell = await activateDesktopShell(
    {
      runtime,
      preloadPath: "/SeaShard/preload.cjs",
      rendererFile: "/SeaShard/index.html",
      smokeMode: true,
      reportOpenFailure: () => {},
      readClientEntryPublication: () => ({ revision: 0, entries: [] }),
      readServerCoreTypes: async () => [],
      readServerCoreVersions: async () => [],
      readServerCoreArtifacts: async () => [],
      resolveServerCoreIconPath: async () => undefined,
      resolveServerInstanceIconPath: async () => undefined,
      readServerSettings: async () => ({
        resourceDownloadDirectory: "/SeaShard/resources",
        defaultDownloadConnections: 8,
        ...defaultServerStartupSettings,
      }),
      writeResourceDownloadDirectory: async (directory) => ({
        resourceDownloadDirectory: directory,
        defaultDownloadConnections: 8,
        ...defaultServerStartupSettings,
      }),
      writeDefaultDownloadConnections: async (connections) => ({
        resourceDownloadDirectory: "/SeaShard/resources",
        defaultDownloadConnections: connections,
        ...defaultServerStartupSettings,
      }),
      writeServerStartupDefaults: async (update) => ({
        resourceDownloadDirectory: "/SeaShard/resources",
        defaultDownloadConnections: 8,
        ...update,
      }),
      startServerCoreDownload: async () => {
        throw new Error("not expected");
      },
      startManagedServerCoreDownload: async () => {
        throw new Error("not expected");
      },
      listServerInstances: async () => [],
      deleteServerInstance: async () => {},
      listServerConfigurations: async (instanceId) => ({
        instanceId,
        configurationRootPath: `/SeaShard/servers/${instanceId}`,
        pluginSupported: false,
        serverFiles: [],
        plugins: [],
      }),
      readServerConfiguration: async () => {
        throw new Error("not expected");
      },
      writeServerConfiguration: async () => {
        throw new Error("not expected");
      },
      readServerRuntime: async (instanceId) => ({ instanceId, state: "stopped" }),
      startServerRuntime: async (instanceId) => ({ instanceId, state: "running" }),
      stopServerRuntime: async (instanceId) => ({ instanceId, state: "stopped" }),
      sendServerCommand: async () => {},
      readServerConsoleLines: async () => [],
      scanJavaInstallations: async () => [],
      inspectJavaInstallation: async () => {
        throw new Error("not expected");
      },
      listServerCoreDownloadTasks: async () => [],
      cancelServerCoreDownload: async () => false,
      onClientEntriesChanged: () => () => {},
      onServerConsoleLine: () => () => {},
    },
    { getSnapshot: async () => snapshot },
  );

  runtime.emit("window-all-closed");
  assert.equal(runtime.quitCount, 0);
  await shell.dispose();
});
