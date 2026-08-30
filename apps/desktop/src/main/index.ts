import { BootstrapLoader } from "@seashard/bootstrap-runtime";
import {
  clientPluginAssetScheme,
  desktopShellContract,
  serverCoreIconScheme,
} from "@seashard/contracts";
import { createSQLiteBootstrapDescriptor } from "@seashard/database-sqlite";
import { createPluginFoundationBootstrapDescriptor } from "@seashard/plugin-foundation";
import {
  PluginKernel,
  pluginDeveloperControlProtocolVersion,
  type PluginDeveloperControlLaunch,
  type PluginKernelOptions,
  type PluginPackageRecord,
} from "@seashard/plugin-system";
import { Context } from "cordis";
import { app, protocol } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerClientFeatures } from "./client-features";
import { publishServerConsoleLine, registerDesktopShellBridge } from "./desktop-shell-bridge";
import {
  createElectronDesktopUpdateService,
  type ElectronDesktopUpdateService,
} from "./desktop-update";
import { registerHostFeatures } from "./host-features";
import { registerSmokePlugin, verifySmokeRuntime } from "./smoke";
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

let kernel: PluginKernel | undefined;
let bootstrapLoader: BootstrapLoader | undefined;
let desktopUpdates: ElectronDesktopUpdateService | undefined;
let bootstrapTask: Promise<void> | undefined;
let shutdownTask: Promise<void> | undefined;
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
  const host = resolveHost();
  desktopUpdates = createElectronDesktopUpdateService(seaShardVersion);
  const userDataRoot = app.getPath("userData");
  const dataRoot = process.env.SEASHARD_DATA_DIR ?? join(userDataRoot, "core");
  const databaseWorkerEntry = join(moduleDirectory, "../../../database-worker/dist/index.js");
  const root = new Context();
  bootstrapLoader = new BootstrapLoader(root);
  await bootstrapLoader.start([
    createSQLiteBootstrapDescriptor({
      dataRoot,
      workerEntry: databaseWorkerEntry,
    }),
    createPluginFoundationBootstrapDescriptor({
      dataRoot,
      workerEntry: databaseWorkerEntry,
      seaShardVersion,
    }),
  ]);
  assertBootstrapContinues();
  kernel = await PluginKernel.create({
    dataRoot,
    seaShardVersion,
    pluginHostEntry: join(moduleDirectory, "../../../plugin-host/dist/index.js"),
    hostProfile: "electron",
    clientTarget: "desktop",
    platform: host.platform,
    architecture: host.architecture,
    root,
    store: root["plugin-foundation"].store,
    pluginStorage: root["plugin-foundation"].storage,
  });
  assertBootstrapContinues();
  const activeKernel = kernel;
  if (smokeMode) {
    kernel.registerCoreService("seashard.smoke.marker", {
      prefix(value) {
        if (typeof value !== "string") throw new TypeError("smoke marker must be a string");
        return `core-${value}`;
      },
    });
  }
  await registerClientFeatures(activeKernel);
  assertBootstrapContinues();
  await registerHostFeatures({
    kernel: activeKernel,
    root,
    dataRoot,
    userDataRoot,
    seaShardVersion,
    startedAt,
    isStopping: () => stopping,
    publishServerConsoleLine,
  });
  assertBootstrapContinues();
  await registerDesktopShellBridge({
    kernel: activeKernel,
    desktopUpdates,
    moduleDirectory,
    ...(developmentUrl ? { developmentUrl } : {}),
    smokeMode,
  });
  assertBootstrapContinues();
  await registerSmokePlugin(activeKernel);
  assertBootstrapContinues();
  developmentPlugin = await registerDevelopmentPlugin(activeKernel, developerControlLaunch);
  assertBootstrapContinues();
  await activeKernel.start();
  assertBootstrapContinues();
  await verifySmokeRuntime(activeKernel, smokeMode);
  assertBootstrapContinues();
  if (developerControlLaunch) {
    const currentDevelopmentRuntimeIds = () =>
      developmentPlugin
        ? activeKernel
            .runtimeSnapshot()
            .plugins.filter((plugin) => plugin.pluginId === developmentPlugin?.manifest.id)
            .map((plugin) => plugin.runtimeId)
        : [];
    for (const runtimeId of currentDevelopmentRuntimeIds()) {
      developmentRuntimeHistory.add(runtimeId);
    }
    disposeDeveloperControl = await startPluginDeveloperControl({
      kernel: activeKernel,
      launch: developerControlLaunch,
      startedAt,
      pluginId: () => developmentPlugin?.manifest.id,
      runtimeIds: currentDevelopmentRuntimeIds,
      logRuntimeIds: () => [...developmentRuntimeHistory],
      refreshDevelopmentPlugin: async () => {
        developmentPlugin = await registerDevelopmentPlugin(
          activeKernel,
          developerControlLaunch,
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
      sessionId: developerControlLaunch.sessionId,
    });
  }

  // 一次性 CLI 操作不创建窗口；开发会话继续加载真实 Renderer，便于联调 Client Entry。
  if (developerControlLaunch?.mode !== "operation") {
    await activeKernel.callService(desktopShellContract, "openPrimary", []);
    assertBootstrapContinues();
  }
  if (developmentUrl) console.log(`SEASHARD_DEV_WINDOW_READY ${developmentUrl}`);
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
      await disposeDeveloperControl?.();
      await kernel?.dispose();
      const activeUnits =
        kernel?.runtimeSnapshot().plugins.filter((plugin) => plugin.state === "active").length ?? 0;
      const diagnostics = kernel?.diagnostics() ?? {
        services: 0,
        contributions: 0,
        clientEntries: 0,
      };
      if (smokeMode) {
        console.log(
          `SEASHARD_SMOKE_DISPOSED activeUnits=${activeUnits} services=${diagnostics.services} contributions=${diagnostics.contributions}`,
        );
      }
      if (developmentUrl) {
        console.log(
          `SEASHARD_DEV_DISPOSED activeUnits=${activeUnits} services=${diagnostics.services}`,
        );
      }
    } finally {
      await bootstrapLoader?.dispose();
    }
  })();
  return shutdownTask;
}

/**
 * 普通 app.quit 会先让 Host 完成完整释放。若本次进程内已有可安装更新，释放成功后
 * 直接以“不重新启动”模式拉起安装器；崩溃与 app.exit(1) 不经过这里，只保留缓存。
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
      if (desktopUpdates.install("close")) return;
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

function resolveHost(): Pick<PluginKernelOptions, "platform" | "architecture"> {
  const platforms: PluginKernelOptions["platform"][] = [
    "win32",
    "darwin",
    "linux",
    "aix",
    "freebsd",
    "openbsd",
    "sunos",
  ];
  const architectures: PluginKernelOptions["architecture"][] = [
    "x64",
    "arm64",
    "ia32",
    "arm",
    "riscv64",
    "ppc64",
    "s390x",
  ];
  if (!platforms.includes(process.platform as PluginKernelOptions["platform"])) {
    throw new Error(`unsupported host platform: ${process.platform}`);
  }
  if (!architectures.includes(process.arch as PluginKernelOptions["architecture"])) {
    throw new Error(`unsupported host architecture: ${process.arch}`);
  }
  return {
    platform: process.platform as PluginKernelOptions["platform"],
    architecture: process.arch as PluginKernelOptions["architecture"],
  };
}
