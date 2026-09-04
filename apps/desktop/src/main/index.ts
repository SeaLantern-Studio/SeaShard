import {
  startSeaShardController,
  type SeaShardControllerRuntime,
} from "@seashard/controller-runtime";
import {
  clientPluginAssetScheme,
  desktopShellContract,
  serverCoreIconScheme,
} from "@seashard/contracts";
import { readHostInstallation } from "@seashard/host-installation";
import {
  connectHostControlClient,
  HostControlRpcError,
  type HostControlClient,
} from "@seashard/host-control";
import { installBundledLinuxHost } from "@seashard/local-host-installer";
import { SQLiteDatabaseBroker } from "@seashard/database-sqlite";
import {
  PluginKernel,
  pluginDeveloperControlProtocolVersion,
  type PluginDeveloperControlLaunch,
  type PluginPackageRecord,
} from "@seashard/plugin-system";
import { app, protocol, shell } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerClientFeatures } from "./client-features";
import { registerControllerFeatures } from "./controller-features";
import { registerLinuxComponentUninstaller } from "./component-uninstaller";
import { registerControllerServerFeatures } from "./controller-server-features";
import { ControllerHostServiceGateway } from "./controller-host-services";
import { registerDesktopShellBridge } from "./desktop-shell-bridge";
import { ControllerServerEventBus, DesktopControllerKernel } from "./desktop-controller-kernel";
import { DesktopHostConnections } from "./desktop-host-connections";
import {
  createElectronDesktopUpdateService,
  type ElectronDesktopUpdateService,
} from "./desktop-update";
import { registerSmokePlugin, verifySmokeRuntime } from "./smoke";
import { HostWorkerDeploymentCoordinator } from "./host-worker-deployment";
import { migrateLegacyHostState } from "./legacy-host-migration";
import { LocalHostProcessLauncher } from "./local-host-process";
import { startPluginDeveloperControl } from "./developer-control";

protocol.registerSchemesAsPrivileged([
  {
    scheme: serverCoreIconScheme,
    privileges: {
      standard: true,
      secure: true,
    },
  },
  {
    scheme: clientPluginAssetScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      codeCache: true,
    },
  },
]);

const smokeMode = process.env.SEASHARD_SMOKE === "1";
const developmentUrl = resolveDevelopmentUrl();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const startedAt = new Date().toISOString();
const seaShardVersion = app.isPackaged ? app.getVersion() : "0.0.0";
const developerControlLaunch = resolvePluginDeveloperControlLaunch();
const disposeDeveloperParentDisconnect = developerControlLaunch
  ? installDeveloperParentDisconnect()
  : undefined;
if (smokeMode) {
  const smokeUserDataRoot = process.env.SEASHARD_SMOKE_USER_DATA_DIR;
  if (!smokeUserDataRoot) {
    throw new Error("SEASHARD_SMOKE_USER_DATA_DIR must isolate Electron smoke data");
  }
  app.setPath("userData", smokeUserDataRoot);
}

if (developmentUrl) installDevelopmentControl();

let controllerRuntime: SeaShardControllerRuntime | undefined;
let controllerServerDatabase: SQLiteDatabaseBroker | undefined;
let desktopUpdates: ElectronDesktopUpdateService | undefined;
let hostConnections: DesktopHostConnections | undefined;
let localHostProcess: LocalHostProcessLauncher | undefined;
let controllerKernel: DesktopControllerKernel | undefined;
let hostWorkerDeployments: HostWorkerDeploymentCoordinator | undefined;
let bootstrapTask: Promise<void> | undefined;
let shutdownTask: Promise<void> | undefined;
let controllerCloseTask: Promise<void> | undefined;
let shutdownComplete = false;
let gracefulQuitTask: Promise<void> | undefined;
let stopping = false;
let signalBootstrapStop!: () => void;
const bootstrapStop = new Promise<void>((resolve) => {
  signalBootstrapStop = resolve;
});
let disposeDeveloperControl: (() => Promise<void>) | undefined;
let developmentPlugin: PluginPackageRecord | undefined;
const developmentRuntimeHistory = new Set<string>();
const controllerIdentity = {
  sessionId: randomUUID(),
  label: `${hostname()} · Desktop ${process.pid}`,
};

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

/**
 * CLI 通过专用 IPC 通道启动开发 Host。父进程崩溃或终端被关闭时，操作系统会断开
 * 通道；由子进程主动进入现有 app.quit/shutdown 链，避免遗留窗口、Runtime 和描述文件。
 */
function installDeveloperParentDisconnect(): () => void {
  let listening = true;
  const requestShutdown = () => {
    if (listening) app.quit();
  };
  if (process.connected) {
    process.once("disconnect", requestShutdown);
  } else {
    queueMicrotask(requestShutdown);
  }
  return () => {
    listening = false;
    process.off("disconnect", requestShutdown);
  };
}

class BootstrapStoppedError extends Error {
  readonly name = "BootstrapStoppedError";
}

function assertBootstrapContinues(): void {
  if (stopping) throw new BootstrapStoppedError("SeaShard bootstrap was stopped");
}

async function waitForApplicationReady(): Promise<void> {
  await Promise.race([
    app.whenReady(),
    bootstrapStop.then(() => {
      throw new BootstrapStoppedError("SeaShard stopped before Electron became ready");
    }),
  ]);
  assertBootstrapContinues();
}

async function bootstrap(): Promise<void> {
  await waitForApplicationReady();
  const userDataRoot = app.getPath("userData");
  const dataRoot = process.env.SEASHARD_DATA_DIR ?? join(userDataRoot, "core");
  const sharedControllerDataRoot = process.env.SEASHARD_DATA_DIR
    ? join(dataRoot, "controller")
    : join(userDataRoot, "controller");
  const desktopControllerDataRoot =
    process.env.SEASHARD_DESKTOP_DATA_DIR ??
    (process.env.SEASHARD_DATA_DIR
      ? join(dataRoot, "desktop-controller")
      : join(userDataRoot, "desktop-controller"));
  const localHostAutoInstallMarker = join(
    desktopControllerDataRoot,
    "local-host-auto-install.disabled",
  );
  if (app.isPackaged && process.platform === "linux") {
    await registerLinuxComponentUninstaller({
      resourcesPath: process.resourcesPath,
      controllerDataRoot: desktopControllerDataRoot,
    }).catch((error) => {
      // 卸载入口登记失败不影响 Controller 与 Host 启动；用户仍可使用系统包管理器。
      console.warn("SeaShard component uninstaller registration failed", error);
    });
  }
  desktopUpdates = createElectronDesktopUpdateService(seaShardVersion, dataRoot);
  if (!app.isPackaged) {
    localHostProcess ??= new LocalHostProcessLauncher({
      hostEntry: resolveDevelopmentHostEntry(),
      executable: process.execPath,
      dataRoot,
      seaShardVersion,
      managedLifecycle: true,
    });
  }

  let connectedHost: HostControlClient | undefined;
  let initialHostError: string | undefined;
  try {
    connectedHost = await connectLocalHost(dataRoot);
  } catch (error) {
    initialHostError = formatError(error);
  }
  assertBootstrapContinues();

  const localInstallation = (await readHostInstallation(dataRoot)) ? "installed" : "missing";
  hostConnections = new DesktopHostConnections({
    controllerSessionId: controllerIdentity.sessionId,
    initialInstallation: localInstallation,
    ...(connectedHost ? { initialClient: connectedHost } : {}),
    ...(initialHostError ? { initialError: initialHostError } : {}),
    connectLocal: () => connectLocalHost(dataRoot),
    readLocalInstallation: async () =>
      (await readHostInstallation(dataRoot)) ? "installed" : "missing",
    installLocal: async () => {
      const result = await openHostInstaller(dataRoot);
      if (result === "installed") {
        await rm(localHostAutoInstallMarker, { force: true });
      }
      return result;
    },
  });

  if (
    app.isPackaged &&
    process.platform === "linux" &&
    !connectedHost &&
    localInstallation === "missing" &&
    !existsSync(localHostAutoInstallMarker)
  ) {
    try {
      // Linux 的 DEB 与 AppImage 都只携带安装资源；首次运行已处于准确的用户环境，
      // 因此可以直接创建该用户的 Host Runtime、数据目录和 XDG 自动启动项。
      await hostConnections.install("local");
    } catch (error) {
      console.error("Bundled SeaShard Host could not be installed during first launch", error);
    }
  } else if (initialHostError) {
    console.error("Local SeaShard Host is unavailable", initialHostError);
  }

  const databaseWorkerEntry = join(moduleDirectory, "../../../database-worker/dist/index.js");
  const activeControllerRuntime = await startSeaShardController({
    dataRoot: sharedControllerDataRoot,
    runtimeDataRoot: desktopControllerDataRoot,
    seaShardVersion,
    databaseWorkerEntry,
    pluginHostEntry: join(moduleDirectory, "../../../plugin-host/dist/index.js"),
    hostProfile: "electron",
    clientTarget: "desktop",
  });
  controllerRuntime = activeControllerRuntime;
  const controllerRoot = activeControllerRuntime.root;
  const applicationKernel = activeControllerRuntime.kernel;
  controllerServerDatabase = await SQLiteDatabaseBroker.create({
    databasePath: join(dataRoot, "seashard.sqlite3"),
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });
  const hostServices = new ControllerHostServiceGateway(hostConnections);
  hostServices.register(applicationKernel);
  if (smokeMode) {
    applicationKernel.registerCoreService("seashard.smoke.marker", {
      prefix(value) {
        if (typeof value !== "string") throw new TypeError("smoke marker must be a string");
        return `core-${value}`;
      },
    });
  }
  const serverEvents = new ControllerServerEventBus();
  await registerControllerServerFeatures({
    kernel: applicationKernel,
    database: controllerServerDatabase,
    hostDataRoot: dataRoot,
    seaShardVersion,
    publishConsoleLine: (line) => serverEvents.publishConsoleLine(line),
  });
  await registerControllerFeatures({
    kernel: applicationKernel,
    userDataRoot,
    legacyCredentialDataRoot: desktopControllerDataRoot,
    startedAt,
    isStopping: () => stopping,
  });
  await registerClientFeatures(applicationKernel);
  await migrateLegacyHostState({
    client: hostConnections.clientFor("local"),
    controller: applicationKernel,
    targetStorage: controllerRoot["plugin-foundation"].storage,
    targetId: createControllerDataId(sharedControllerDataRoot),
  });
  await registerSmokePlugin(applicationKernel);
  developmentPlugin = await registerDevelopmentPlugin(applicationKernel, developerControlLaunch);

  hostWorkerDeployments = new HostWorkerDeploymentCoordinator(applicationKernel, hostConnections);
  hostWorkerDeployments.start();
  controllerKernel = new DesktopControllerKernel(
    activeControllerRuntime,
    hostConnections,
    serverEvents,
  );
  if (developerControlLaunch?.mode !== "operation") {
    await registerDesktopShellBridge({
      kernel: controllerKernel,
      desktopUpdates,
      moduleDirectory,
      ...(developmentUrl ? { developmentUrl } : {}),
      smokeMode,
      onControllerWindowAllClosed: () => {
        void closeControllerWindow();
      },
    });
  }
  await applicationKernel.start();
  await verifySmokeRuntime(applicationKernel, smokeMode);
  if (developerControlLaunch) {
    await startControllerDeveloperControl(applicationKernel, developerControlLaunch);
  }
  if (developerControlLaunch?.mode !== "operation") {
    await controllerKernel.callService(desktopShellContract, "openPrimary", []);
  }
  assertBootstrapContinues();
  if (developmentUrl) console.log(`SEASHARD_DEV_WINDOW_READY ${developmentUrl}`);
}

/**
 * Linux Controller 随包安装器必须等待 Host 真正就绪并由调用方立即重连。其他平台
 * 打开独立安装包下载地址，安装生命周期继续交给用户和系统安装器。
 */
async function openHostInstaller(dataRoot: string): Promise<"installed" | "external"> {
  const bundledInstaller = resolveBundledHostInstaller();
  if (!bundledInstaller) {
    await shell.openExternal(resolveHostInstallerDownloadUrl());
    return "external";
  }

  await installBundledLinuxHost({
    dataRoot,
    hostImage: bundledInstaller.hostImage,
    installScript: bundledInstaller.installScript,
  });
  return "installed";
}

interface BundledHostInstaller {
  readonly hostImage: string;
  readonly installScript: string;
}

function resolveBundledHostInstaller(): BundledHostInstaller | undefined {
  if (!app.isPackaged || process.platform !== "linux") return undefined;
  const installerRoot = join(process.resourcesPath, "host-installer");
  return {
    hostImage: join(installerRoot, "SeaShardHostSetup.AppImage"),
    installScript: join(installerRoot, "install.sh"),
  };
}

function resolveHostInstallerDownloadUrl(): string {
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const releaseRoot = "https://github.com/SeaLantern-Studio/SeaShard/releases/latest/download";
  if (process.platform === "win32") {
    return `${releaseRoot}/SeaShard-Host-windows-${architecture}.exe`;
  }
  if (process.platform === "darwin") {
    return `${releaseRoot}/SeaShard-Host-macos-${architecture}.pkg`;
  }
  if (process.platform === "linux") {
    const extension = process.env.APPIMAGE ? "AppImage" : "deb";
    return `${releaseRoot}/SeaShard-Host-linux-${architecture}.${extension}`;
  }
  return "https://github.com/SeaLantern-Studio/SeaShard/releases/latest";
}

function resolveDevelopmentHostEntry(): string {
  return join(moduleDirectory, "../../../host/dist/index.js");
}

async function connectLocalHost(dataRoot: string): Promise<HostControlClient> {
  const existing = await tryConnectHost(dataRoot);
  if (existing) return existing;

  // 开发工具链需要同进程树的源码 Host；发行版 Controller 永远不代替安装器启动 Host。
  if (localHostProcess) {
    await localHostProcess.ensureStarted();
    const startedHost = await waitForHost(dataRoot);
    if (startedHost) return startedHost;
    throw new HostControlRpcError("HOST_START_FAILED", "开发 Host 已启动，但没有发布控制端点");
  }

  const installation = await readHostInstallation(dataRoot);
  if (!installation) {
    throw new HostControlRpcError("HOST_NOT_INSTALLED", "本机尚未安装 SeaShard Host");
  }
  throw new HostControlRpcError(
    "HOST_UNAVAILABLE",
    "本机 SeaShard Host 已安装但未运行，请启动 Host 后重新连接",
  );
}

async function tryConnectHost(dataRoot: string): Promise<HostControlClient | undefined> {
  try {
    return await connectHostControlClient({ dataRoot, identity: controllerIdentity });
  } catch (error) {
    if (isUnavailableHost(error)) return undefined;
    throw error;
  }
}

async function waitForHost(dataRoot: string): Promise<HostControlClient | undefined> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    assertBootstrapContinues();
    const client = await tryConnectHost(dataRoot);
    if (client) return client;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

function isUnavailableHost(error: unknown): boolean {
  const code =
    error instanceof HostControlRpcError
      ? error.code
      : error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
  return (
    code === "HOST_UNAVAILABLE" ||
    code === "HOST_CONNECT_TIMEOUT" ||
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeControllerWindow(): Promise<void> {
  controllerCloseTask ??= (async () => {
    await controllerKernel?.dispose();
    controllerKernel = undefined;
    await controllerRuntime?.dispose();
    controllerRuntime = undefined;
    hostConnections?.dispose();
    hostConnections = undefined;
    app.quit();
  })();
  return controllerCloseTask;
}

async function shutdown(): Promise<void> {
  shutdownTask ??= (async () => {
    stopping = true;
    signalBootstrapStop();
    disposeDeveloperParentDisconnect?.();
    // Bootstrap 先完整退出当前异步步骤，Shutdown 才释放其 Loader、Kernel 和 Cordis Context。
    // 这条屏障同时覆盖父 IPC 断开、正常退出和启动失败三条路径。
    await bootstrapTask?.catch(() => undefined);
    try {
      const hadController = Boolean(controllerKernel);
      await controllerKernel?.dispose();
      controllerKernel = undefined;
      hostConnections?.dispose();
      hostConnections = undefined;
      await disposeDeveloperControl?.();
      hostWorkerDeployments?.dispose();
      hostWorkerDeployments = undefined;
      if (smokeMode && hadController) console.log("SEASHARD_SMOKE_CONTROLLER_DISPOSED");
      if (developmentUrl && hadController) console.log("SEASHARD_DEV_CONTROLLER_DISPOSED");
    } finally {
      await controllerRuntime?.dispose();
      controllerRuntime = undefined;
      await controllerServerDatabase?.close();
      controllerServerDatabase = undefined;
      await localHostProcess?.dispose();
      localHostProcess = undefined;
    }
  })();
  return shutdownTask;
}

/**
 * Controller 更新只关闭 Controller 自身；独立安装的 Host 及其服务器运行事实保持不变。
 */
async function finishGracefulQuit(installDownloadedUpdate: boolean): Promise<void> {
  let shutdownSucceeded = false;
  try {
    await shutdown();
    shutdownSucceeded = true;
  } catch (error) {
    console.error("SeaShard shutdown failed", error);
  }

  shutdownComplete = true;
  if (shutdownSucceeded && installDownloadedUpdate && desktopUpdates?.isRestartRequired()) {
    try {
      const result = await desktopUpdates.install("close");
      if (result.controllerInstallerStarted) return;
    } catch (error) {
      console.error("SeaShard update install on quit failed", error);
    }
  }
  desktopUpdates?.dispose();
  app.quit();
}

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  gracefulQuitTask ??= finishGracefulQuit(desktopUpdates?.isRestartRequired() ?? false);
});

bootstrapTask = bootstrap();
void bootstrapTask.catch((error) => {
  if (error instanceof BootstrapStoppedError) return;
  console.error("SeaShard bootstrap failed", error);
  void shutdown().finally(() => {
    desktopUpdates?.dispose();
    app.exit(1);
  });
});

function resolvePluginDeveloperControlLaunch(): PluginDeveloperControlLaunch | undefined {
  const encoded = process.env.SEASHARD_PLUGIN_DEVELOPER_CONTROL;
  if (!encoded) return undefined;
  const value = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as Partial<PluginDeveloperControlLaunch>;
  if (
    value.protocolVersion !== pluginDeveloperControlProtocolVersion ||
    typeof value.sessionId !== "string" ||
    !/^[a-f0-9]{24}$/u.test(value.sessionId) ||
    typeof value.token !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.token) ||
    typeof value.socketPath !== "string" ||
    typeof value.descriptorPath !== "string" ||
    (value.mode !== "development" && value.mode !== "operation") ||
    (value.mode === "development" && typeof value.pluginRoot !== "string")
  ) {
    throw new TypeError("SEASHARD_PLUGIN_DEVELOPER_CONTROL is invalid");
  }
  return value as PluginDeveloperControlLaunch;
}

async function registerDevelopmentPlugin(
  activeKernel: PluginKernel,
  launch: PluginDeveloperControlLaunch | undefined,
  previousPluginId?: string,
): Promise<PluginPackageRecord | undefined> {
  if (launch?.mode !== "development" || !launch.pluginRoot) return undefined;
  return activeKernel.refreshDevelopmentDirectory(launch.pluginRoot, previousPluginId);
}

/** 插件开发控制通道属于 Controller Plugin Runtime，与服务器 Host 生命周期解耦。 */
async function startControllerDeveloperControl(
  activeKernel: PluginKernel,
  launch: PluginDeveloperControlLaunch,
): Promise<void> {
  const currentDevelopmentRuntimeIds = () =>
    developmentPlugin
      ? activeKernel
          .runtimeSnapshot()
          .plugins.filter((plugin) => plugin.pluginId === developmentPlugin?.manifest.id)
          .map((plugin) => plugin.runtimeId)
      : [];
  for (const runtimeId of currentDevelopmentRuntimeIds()) developmentRuntimeHistory.add(runtimeId);
  disposeDeveloperControl = await startPluginDeveloperControl({
    kernel: activeKernel,
    launch,
    startedAt,
    pluginId: () => developmentPlugin?.manifest.id,
    runtimeIds: currentDevelopmentRuntimeIds,
    logRuntimeIds: () => [...developmentRuntimeHistory],
    refreshDevelopmentPlugin: async () => {
      developmentPlugin = await registerDevelopmentPlugin(
        activeKernel,
        launch,
        developmentPlugin?.manifest.id,
      );
      for (const runtimeId of currentDevelopmentRuntimeIds()) {
        developmentRuntimeHistory.add(runtimeId);
      }
    },
    requestShutdown: () => app.quit(),
  });
  assertBootstrapContinues();
  process.send?.({
    type: "seashard:plugin-developer-control-ready",
    sessionId: launch.sessionId,
  });
}

function createControllerDataId(dataRoot: string): string {
  return createHash("sha256").update(dataRoot).digest("hex");
}
