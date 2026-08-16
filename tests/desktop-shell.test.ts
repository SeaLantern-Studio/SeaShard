import {
  desktopChannels,
  desktopShellContract,
  runtimeDiagnosticsContract,
  type ClientEntryPublication,
  type DesktopClientBootstrap,
  type DesktopShellService,
  type RuntimeDiagnosticsService,
  type RuntimeSnapshot,
  type ServerCoreArtifact,
} from "../packages/contracts/src/index.ts";
import {
  createDesktopShellModule,
  type DesktopShellConfig,
  type DesktopShellRuntime,
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
  quitCount = 0;
  directorySelection = "C:/SeaShard/resources";
  directorySelectionWindow?: BrowserWindow;

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

  async invoke(channel: string, senderId: number, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return handler({ sender: { id: senderId } } as IpcMainInvokeEvent, ...args);
  }

  async selectDirectory(window: BrowserWindow): Promise<string | undefined> {
    this.directorySelectionWindow = window;
    return this.directorySelection;
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

await test("desktop shell owns window, sender authorization, and IPC as one lifecycle", async () => {
  const runtime = new FakeDesktopShellRuntime("win32");
  const failures: unknown[] = [];
  const readySnapshots: RuntimeSnapshot[] = [];
  let clientEntryListener: ((publication: ClientEntryPublication) => void) | undefined;
  let serverSettings = { resourceDownloadDirectory: "C:/SeaShard/resources" };
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
      readServerCoreTypes: async () => ["vanilla", "paper"],
      readServerCoreVersions: async (serverType) => (serverType === "paper" ? ["1.21.1"] : []),
      readServerCoreArtifacts: async (serverType, gameVersion) =>
        serverType === "paper" && gameVersion === "1.21.1" ? [paperArtifact] : [],
      readServerSettings: async () => serverSettings,
      writeResourceDownloadDirectory: async (directory) => {
        serverSettings = { resourceDownloadDirectory: directory };
        return serverSettings;
      },
      onClientEntriesChanged: (listener) => {
        clientEntryListener = listener;
        return () => {
          if (clientEntryListener === listener) clientEntryListener = undefined;
        };
      },
    },
    { getSnapshot: async () => snapshot },
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
    { resourceDownloadDirectory: "D:/Servers/resources" },
  );
  assert.deepEqual(serverSettings, { resourceDownloadDirectory: "D:/Servers/resources" });
  await assert.rejects(
    runtime.invoke(desktopChannels.serverSettingsSetResourceDownloadDirectory, 1, 42),
    /must be a string/,
  );
  await assert.rejects(runtime.invoke(desktopChannels.serverSettingsGet, 999), /request rejected/);
  await assert.rejects(
    runtime.invoke(desktopChannels.serverSettingsSetResourceDownloadDirectory, 999, "E:/Rejected"),
    /request rejected/,
  );
  assert.equal(await runtime.invoke(desktopChannels.runtimeSnapshot, 1), snapshot);
  await assert.rejects(runtime.invoke(desktopChannels.runtimeSnapshot, 999), /request rejected/);
  assert.deepEqual(await runtime.invoke(desktopChannels.serverCoreTypes, 1), ["vanilla", "paper"]);
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
  assert.equal(runtime.handlers.has(desktopChannels.clientBootstrap), false);
  assert.equal(runtime.handlers.has(desktopChannels.rendererReady), false);
  assert.equal(runtime.handlers.has(desktopChannels.windowMinimize), false);
  assert.equal(runtime.handlers.has(desktopChannels.windowToggleMaximize), false);
  assert.equal(runtime.handlers.has(desktopChannels.windowClose), false);
  assert.equal(runtime.handlers.has(desktopChannels.dialogSelectDirectory), false);
  assert.equal(clientEntryListener, undefined);
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
      readServerSettings: async () => ({ resourceDownloadDirectory: "/SeaShard/resources" }),
      writeResourceDownloadDirectory: async (directory) => ({
        resourceDownloadDirectory: directory,
      }),
      onClientEntriesChanged: () => () => {},
    },
    { getSnapshot: async () => snapshot },
  );

  runtime.emit("window-all-closed");
  assert.equal(runtime.quitCount, 0);
  await shell.dispose();
});
