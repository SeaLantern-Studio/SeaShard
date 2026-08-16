import {
  desktopChannels,
  desktopShellContract,
  runtimeDiagnosticsContract,
  type DesktopShellService,
  type RuntimeDiagnosticsService,
  type RuntimeSnapshot,
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
  windowOpenHandler?: () => unknown;
  permissionRequestHandler?: (
    contents: unknown,
    permission: string,
    callback: (allowed: boolean) => void,
  ) => void;

  constructor(
    id: number,
    readonly options: BrowserWindowConstructorOptions,
  ) {
    super();
    this.webContents = {
      id,
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
  readonly handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>();
  quitCount = 0;

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

  handle(channel: string, listener: (event: IpcMainInvokeEvent) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async invoke(channel: string, senderId: number): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return handler({ sender: { id: senderId } } as IpcMainInvokeEvent);
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

await test("desktop shell owns window, sender authorization, and IPC as one lifecycle", async () => {
  const runtime = new FakeDesktopShellRuntime("win32");
  const failures: unknown[] = [];
  const served: RuntimeSnapshot[] = [];
  const shell = await activateDesktopShell(
    {
      runtime,
      preloadPath: "C:/SeaShard/preload.cjs",
      rendererFile: "C:/SeaShard/index.html",
      smokeMode: false,
      reportOpenFailure: (error) => failures.push(error),
      onRuntimeSnapshotServed: (value) => served.push(value),
    },
    { getSnapshot: async () => snapshot },
  );

  assert.equal(runtime.handlers.has(desktopChannels.runtimeSnapshot), true);
  await assert.rejects(runtime.invoke(desktopChannels.runtimeSnapshot, 1), /request rejected/);

  await Promise.all([shell.service.openPrimary(), shell.service.openPrimary()]);
  assert.equal(runtime.windows.length, 1, "concurrent opens must share one primary window");
  const first = runtime.windows[0];
  assert.equal(first.loadedFile, "C:/SeaShard/index.html");
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

  assert.equal(await runtime.invoke(desktopChannels.runtimeSnapshot, 1), snapshot);
  await assert.rejects(runtime.invoke(desktopChannels.runtimeSnapshot, 999), /request rejected/);
  assert.deepEqual(served, [snapshot]);

  first.emit("ready-to-show");
  assert.equal(first.shown, true);
  first.destroy();
  runtime.emit("activate");
  assert.equal(runtime.windows.length, 2, "activate must recreate a closed primary window");

  runtime.emit("window-all-closed");
  assert.equal(runtime.quitCount, 1);
  await shell.dispose();
  assert.equal(runtime.windows[1].destroyed, true);
  assert.equal(runtime.listenerCount("activate"), 0);
  assert.equal(runtime.listenerCount("window-all-closed"), 0);
  assert.equal(runtime.handlers.has(desktopChannels.runtimeSnapshot), false);
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
    },
    { getSnapshot: async () => snapshot },
  );

  runtime.emit("window-all-closed");
  assert.equal(runtime.quitCount, 0);
  await shell.dispose();
});
