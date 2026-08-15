import { getBootstrapProbe, bootstrapStatusPlugin } from "@seashard/bootstrap-status";
import { ComponentSupervisor } from "@seashard/component-supervisor";
import { desktopGatewayPlugin } from "@seashard/desktop-gateway";
import { app, BrowserWindow } from "electron";
import { Context } from "cordis";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const smokeMode = process.env.SEASHARD_SMOKE === "1";
const developmentUrl = resolveDevelopmentUrl();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

if (developmentUrl) installDevelopmentControl();

let mainWindow: BrowserWindow | null = null;
let supervisor: ComponentSupervisor | undefined;
let shutdownTask: Promise<void> | undefined;
let shutdownComplete = false;
let smokeQuitScheduled = false;

function resolveDevelopmentUrl(): string | undefined {
  const argumentPrefix = "--seashard-dev-server-url=";
  const argument = process.argv.find((value) => value.startsWith(argumentPrefix));
  const candidate = process.env.SEASHARD_DEV_SERVER_URL ?? argument?.slice(argumentPrefix.length);
  if (!candidate) return undefined;

  const url = new URL(candidate);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]")
  ) {
    throw new Error(`development server must use loopback HTTP: ${candidate}`);
  }
  return url.href;
}

function installDevelopmentControl(): void {
  process.on("message", (message: unknown) => {
    if (message === "seashard:quit") app.quit();
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const root = new Context();
  supervisor = new ComponentSupervisor(root);

  await supervisor.start({
    id: "bootstrap.status",
    displayName: "Bootstrap status",
    plugin: bootstrapStatusPlugin,
  });

  await supervisor.start({
    id: "desktop.gateway",
    displayName: "Electron contract gateway",
    plugin: desktopGatewayPlugin,
    config: {
      authorize: (event) => event.sender === mainWindow?.webContents,
      getRuntimeSnapshot: () => supervisor!.snapshot(),
      onRuntimeSnapshotServed: (snapshot) => {
        if (!smokeMode || smokeQuitScheduled) return;
        smokeQuitScheduled = true;
        console.log(`SEASHARD_SMOKE_READY components=${snapshot.components.length}`);
        setTimeout(() => app.quit(), 50).unref();
      },
    },
  });

  mainWindow = createWindow();
  await loadRenderer(mainWindow);
  if (developmentUrl) console.log(`SEASHARD_DEV_WINDOW_READY ${developmentUrl}`);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f3f1eb",
    webPreferences: {
      preload: join(moduleDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  window.once("ready-to-show", () => {
    if (!smokeMode) window.show();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  return window;
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  if (developmentUrl) {
    await window.loadURL(developmentUrl);
    return;
  }
  await window.loadFile(join(moduleDirectory, "../renderer/index.html"));
}

async function shutdown(): Promise<void> {
  shutdownTask ??= (async () => {
    await supervisor?.dispose();
    const probe = getBootstrapProbe();
    if (smokeMode) {
      console.log(`SEASHARD_SMOKE_DISPOSED activeResources=${probe.activeResources}`);
    }
    if (developmentUrl) {
      console.log(`SEASHARD_DEV_DISPOSED activeResources=${probe.activeResources}`);
    }
  })();
  return shutdownTask;
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && supervisor) {
    mainWindow = createWindow();
    void loadRenderer(mainWindow);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  void shutdown().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});

void bootstrap().catch((error) => {
  console.error("SeaShard bootstrap failed", error);
  void shutdown().finally(() => app.exit(1));
});
