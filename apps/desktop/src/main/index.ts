import { BootstrapLoader } from "@seashard/bootstrap-runtime";
import {
  clientPluginAssetScheme,
  desktopShellContract,
  serverCoreIconScheme,
} from "@seashard/contracts";
import {
  connectHostControlClient,
  HostControlRpcError,
  type HostControlClient,
} from "@seashard/host-control";
import { createSQLiteBootstrapDescriptor, SQLiteDatabaseBroker } from "@seashard/database-sqlite";
import {
  createPluginFoundationBootstrapDescriptor,
  type SQLitePluginDocumentStorage,
} from "@seashard/plugin-foundation";
import {
  PluginKernel,
  automaticPluginBindingId,
  automaticPluginBindingPrefix,
  pluginDeveloperControlProtocolVersion,
  type PluginDeveloperControlLaunch,
  type PluginKernelOptions,
  type PluginPackageRecord,
} from "@seashard/plugin-system";
import { Context } from "cordis";
import { app, protocol } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerClientFeatures } from "./client-features";
import { registerControllerFeatures } from "./controller-features";
import { registerControllerServerFeatures } from "./controller-server-features";
import { ControllerHostServiceGateway } from "./controller-host-services";
import { registerDesktopShellBridge } from "./desktop-shell-bridge";
import { ControllerServerEventBus, DesktopControllerKernel } from "./desktop-controller-kernel";
import {
  startDesktopHostControlServer,
  type DesktopHostControlServer,
} from "./desktop-host-control";
import { DesktopHostConnections } from "./desktop-host-connections";
import {
  createElectronDesktopUpdateService,
  type ElectronDesktopUpdateService,
} from "./desktop-update";
import { registerHostFeatures } from "./host-features";
import { registerSmokePlugin, verifySmokeRuntime } from "./smoke";
import {
  HostWorkerDeploymentCoordinator,
  registerHostWorkerDeploymentService,
} from "./host-worker-deployment";
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
let legacyHostPluginStorage: SQLitePluginDocumentStorage | undefined;
let controllerBootstrapLoader: BootstrapLoader | undefined;
let controllerServerDatabase: SQLiteDatabaseBroker | undefined;
let desktopUpdates: ElectronDesktopUpdateService | undefined;
let hostControlServer: DesktopHostControlServer | undefined;
let hostConnections: DesktopHostConnections | undefined;
let controllerKernel: DesktopControllerKernel | undefined;
let hostWorkerDeployments: HostWorkerDeploymentCoordinator | undefined;
let bootstrapTask: Promise<void> | undefined;
let shutdownTask: Promise<void> | undefined;
let controllerCloseTask: Promise<void> | undefined;
let shutdownComplete = false;
let gracefulQuitTask: Promise<void> | undefined;
let ownsHost = false;
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
  desktopUpdates = createElectronDesktopUpdateService(seaShardVersion);
  const userDataRoot = app.getPath("userData");
  const dataRoot = process.env.SEASHARD_DATA_DIR ?? join(userDataRoot, "core");

  let connectedHost: HostControlClient | undefined;
  let initialHostError: string | undefined;
  try {
    connectedHost = await connectLocalHost(dataRoot);
  } catch (error) {
    initialHostError = formatError(error);
    console.error("Local SeaShard Host is unavailable", error);
  }
  assertBootstrapContinues();

  hostConnections = new DesktopHostConnections({
    controllerSessionId: controllerIdentity.sessionId,
    ...(connectedHost ? { initialClient: connectedHost } : {}),
    ...(initialHostError ? { initialError: initialHostError } : {}),
    connectLocal: () => connectLocalHost(dataRoot),
  });

  // 每个 Desktop 都启动自己的完整 Controller Runtime；operation 模式只省略窗口。
  const controllerDataRoot = process.env.SEASHARD_DATA_DIR
    ? join(dataRoot, "controller")
    : join(userDataRoot, "controller");
  const databaseWorkerEntry = join(moduleDirectory, "../../../database-worker/dist/index.js");
  const controllerRoot = new Context();
  controllerBootstrapLoader = new BootstrapLoader(controllerRoot);
  await controllerBootstrapLoader.start([
    createSQLiteBootstrapDescriptor({
      dataRoot: controllerDataRoot,
      workerEntry: databaseWorkerEntry,
    }),
    createPluginFoundationBootstrapDescriptor({
      dataRoot: controllerDataRoot,
      workerEntry: databaseWorkerEntry,
      seaShardVersion,
    }),
  ]);
  controllerServerDatabase = await SQLiteDatabaseBroker.create({
    databasePath: join(dataRoot, "seashard.sqlite3"),
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });
  const host = resolveHost();
  const applicationKernel = await PluginKernel.create({
    dataRoot: controllerDataRoot,
    seaShardVersion,
    pluginHostEntry: join(moduleDirectory, "../../../plugin-host/dist/index.js"),
    hostProfile: "electron",
    clientTarget: "desktop",
    platform: host.platform,
    architecture: host.architecture,
    root: controllerRoot,
    store: controllerRoot["plugin-foundation"].store,
    pluginStorage: controllerRoot["plugin-foundation"].storage,
    executionLocation: "controller",
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
    startedAt,
    isStopping: () => stopping,
  });
  await registerClientFeatures(applicationKernel);
  if (ownsHost && kernel && legacyHostPluginStorage) {
    const legacyPluginIds = await migrateLegacyHostPlugins(kernel, applicationKernel);
    await migrateLegacyPluginDocuments({
      source: legacyHostPluginStorage,
      target: controllerRoot["plugin-foundation"].storage,
      ownerIds: [...legacyPluginIds, "seashard.server-settings"],
      targetId: createHash("sha256").update(controllerDataRoot).digest("hex"),
    });
  }
  await registerSmokePlugin(applicationKernel);
  developmentPlugin = await registerDevelopmentPlugin(applicationKernel, developerControlLaunch);

  hostWorkerDeployments = new HostWorkerDeploymentCoordinator(applicationKernel, hostConnections);
  hostWorkerDeployments.start();
  controllerKernel = new DesktopControllerKernel(applicationKernel, hostConnections, serverEvents);
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

async function startLocalHost(dataRoot: string): Promise<void> {
  const host = resolveHost();
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
  legacyHostPluginStorage = root["plugin-foundation"].storage;
  ownsHost = true;
  assertBootstrapContinues();
  kernel = await PluginKernel.create({
    dataRoot,
    seaShardVersion,
    pluginHostEntry: join(moduleDirectory, "../../../plugin-host/dist/index.js"),
    hostProfile: "electron",
    platform: host.platform,
    architecture: host.architecture,
    root,
    store: root["plugin-foundation"].store,
    pluginStorage: root["plugin-foundation"].storage,
    executionLocation: "host",
    agentExtensions: false,
  });
  assertBootstrapContinues();
  const activeKernel = kernel;
  await registerHostFeatures({
    kernel: activeKernel,
    seaShardVersion,
  });
  assertBootstrapContinues();
  registerHostWorkerDeploymentService(activeKernel);
  await activeKernel.start();
  assertBootstrapContinues();
  hostControlServer = await startDesktopHostControlServer(activeKernel, dataRoot, startedAt);
}

async function connectLocalHost(dataRoot: string): Promise<HostControlClient> {
  const existing = await tryConnectHost(dataRoot);
  if (existing) return existing;

  try {
    await startLocalHost(dataRoot);
  } catch (error) {
    // 并发启动时，失去 dataRoot 租约的 Controller 等待胜者发布 Host；其他错误会进入界面状态。
    await disposeFailedLocalHostStart();
    const racedHost = await waitForHost(dataRoot);
    if (racedHost) return racedHost;
    throw error;
  }
  return connectHostControlClient({ dataRoot, identity: controllerIdentity });
}

async function disposeFailedLocalHostStart(): Promise<void> {
  await disposeDeveloperControl?.().catch(() => undefined);
  disposeDeveloperControl = undefined;
  await hostControlServer?.dispose().catch(() => undefined);
  hostControlServer = undefined;
  await kernel?.dispose().catch(() => undefined);
  kernel = undefined;
  await bootstrapLoader?.dispose().catch(() => undefined);
  bootstrapLoader = undefined;
  legacyHostPluginStorage = undefined;
  developmentPlugin = undefined;
  ownsHost = false;
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
    await controllerBootstrapLoader?.dispose();
    controllerBootstrapLoader = undefined;
    hostConnections?.dispose();
    hostConnections = undefined;
    const keepHostAlive =
      ownsHost && !smokeMode && !developmentUrl && developerControlLaunch === undefined;
    if (!keepHostAlive) app.quit();
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
      await controllerKernel?.dispose();
      controllerKernel = undefined;
      hostConnections?.dispose();
      hostConnections = undefined;
      await disposeDeveloperControl?.();
      hostWorkerDeployments?.dispose();
      hostWorkerDeployments = undefined;
      await hostControlServer?.dispose();
      hostControlServer = undefined;
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
      await controllerBootstrapLoader?.dispose();
      controllerBootstrapLoader = undefined;
      await controllerServerDatabase?.close();
      controllerServerDatabase = undefined;
      await bootstrapLoader?.dispose();
      bootstrapLoader = undefined;
      legacyHostPluginStorage = undefined;
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

/** 将旧 Host Runtime 中的正式插件复制到当前 Controller，不修改或删除旧数据。 */
async function migrateLegacyHostPlugins(
  legacyHost: PluginKernel,
  controller: PluginKernel,
): Promise<readonly string[]> {
  const currentIds = new Set(
    (await controller.registry.listCurrentPackages()).map(({ manifest }) => manifest.id),
  );
  const legacyRecords = (await legacyHost.registry.listCurrentPackages()).filter(
    ({ source }) => source === "installed",
  );
  for (const legacy of legacyRecords) {
    if (currentIds.has(legacy.manifest.id)) continue;
    const prepared = await controller.prepareDirectory(legacy.rootPath);
    try {
      const imported = await prepared.commit({
        digest: prepared.digest,
        acknowledgeFullMachineAccess: true,
      });
      const legacyBindings = await legacyHost.registry.listBindings(legacy.manifest.id);
      const nextBindings = imported.manifest.entries.map((entry) => {
        const previous = legacyBindings.find(({ entryId }) => entryId === entry.id);
        return {
          id: automaticPluginBindingId("plugin", imported.manifest.id, entry.id),
          pluginId: imported.manifest.id,
          entryId: entry.id,
          scopeType: "global" as const,
          scopeId: "global",
          enabled: previous?.enabled ?? true,
          config: previous?.config ?? {},
        };
      });
      await controller.registry.replacePackageSelectionAndBindings(
        imported.manifest.id,
        imported,
        automaticPluginBindingPrefix("plugin", imported.manifest.id),
        nextBindings,
      );
      currentIds.add(imported.manifest.id);
    } finally {
      await prepared.dispose();
    }
  }
  return legacyRecords.map(({ manifest }) => manifest.id);
}

const legacyPluginDocumentMigrationId = "host-plugin-documents-to-controller-v1";

/**
 * 标准插件文档迁移先幂等写入 Controller，再在旧 Host 数据库记录完成标记。
 * 若进程在两步之间退出，下一次导入使用 create-only 冲突策略安全重放。
 */
async function migrateLegacyPluginDocuments(options: {
  readonly source: SQLitePluginDocumentStorage;
  readonly target: SQLitePluginDocumentStorage;
  readonly ownerIds: readonly string[];
  readonly targetId: string;
}): Promise<void> {
  const completed = await options.source.readMigrationMarker(legacyPluginDocumentMigrationId);
  if (completed) return;

  const documents = await options.source.exportOwners(options.ownerIds);
  await options.target.importDocuments(documents);
  await options.source.completeMigration({
    migrationId: legacyPluginDocumentMigrationId,
    targetId: options.targetId,
    documentCount: documents.length,
    completedAt: new Date().toISOString(),
  });
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
