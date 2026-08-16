import {
  desktopWindowHostContract,
  type DesktopWindowHostService,
} from "../packages/contracts/src/index.ts";
import {
  createDesktopWindowHostModule,
  type DesktopWindowHostConfig,
  type DesktopWindowRuntime,
} from "../components/desktop-window-host/src/index.ts";
import type {
  Disposable,
  PluginContext,
  ServiceProvider,
} from "../packages/plugin-sdk/src/index.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

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

class FakeDesktopWindowRuntime extends EventEmitter implements DesktopWindowRuntime {
  readonly windows: FakeBrowserWindow[] = [];
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

  quit(): void {
    this.quitCount += 1;
  }
}

async function activateWindowHost(
  config: DesktopWindowHostConfig,
): Promise<{ service: DesktopWindowHostService; dispose: () => Promise<void> }> {
  const providers = new Map<string, ServiceProvider>();
  const disposers: Disposable[] = [];
  const context = {
    provide(contract: string, provider: ServiceProvider) {
      providers.set(contract, provider);
    },
    effect(execute: () => void | Disposable | Promise<void | Disposable>) {
      const result = execute();
      if (result instanceof Promise) throw new Error("test harness requires synchronous effects");
      if (result) disposers.push(result);
    },
  } as unknown as PluginContext;

  await createDesktopWindowHostModule(config).apply(context, null);
  const service = providers.get(desktopWindowHostContract);
  assert.ok(service, "window host must publish its service");

  return {
    service: service as unknown as DesktopWindowHostService,
    dispose: async () => {
      for (const disposer of disposers.reverse()) await disposer();
    },
  };
}

await test("desktop window host owns the primary window lifecycle and security boundary", async () => {
  const runtime = new FakeDesktopWindowRuntime("win32");
  const failures: unknown[] = [];
  const host = await activateWindowHost({
    runtime,
    preloadPath: "C:/SeaShard/preload.cjs",
    rendererFile: "C:/SeaShard/index.html",
    smokeMode: false,
    reportOpenFailure: (error) => failures.push(error),
  });

  await Promise.all([host.service.openPrimary(), host.service.openPrimary()]);
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
  assert.equal(await host.service.ownsWebContents(1), true);
  assert.equal(await host.service.ownsWebContents(999), false);

  first.emit("ready-to-show");
  assert.equal(first.shown, true);
  first.destroy();
  runtime.emit("activate");
  assert.equal(runtime.windows.length, 2, "activate must recreate a closed primary window");

  runtime.emit("window-all-closed");
  assert.equal(runtime.quitCount, 1);
  await host.dispose();
  assert.equal(runtime.windows[1].destroyed, true);
  assert.equal(runtime.listenerCount("activate"), 0);
  assert.equal(runtime.listenerCount("window-all-closed"), 0);
  assert.deepEqual(failures, []);
});

await test("desktop window host keeps macOS alive after the last window closes", async () => {
  const runtime = new FakeDesktopWindowRuntime("darwin");
  const host = await activateWindowHost({
    runtime,
    preloadPath: "/SeaShard/preload.cjs",
    rendererFile: "/SeaShard/index.html",
    smokeMode: true,
    reportOpenFailure: () => {},
  });

  runtime.emit("window-all-closed");
  assert.equal(runtime.quitCount, 0);
  await host.dispose();
});
