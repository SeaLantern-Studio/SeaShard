import { registerAgentClientFeatures } from "@seashard/agent-client-features";
import {
  ControllerHostWorkerDeployments,
  startSeaShardController,
  type SeaShardControllerRuntime,
} from "@seashard/controller-runtime";
import { registerServerClientFeatures } from "@seashard/server-client-features";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerServerAgentFeatures } from "./agent-features";
import { prepareServerLocalHost } from "./host-setup";
import { ServerHostServiceGateway } from "./host-service-gateway";
import { ServerLocalHostConnection } from "./local-host";
import { ServerControllerLogger } from "./logger";
import { resolveServerControllerPaths } from "./paths";
import { ServerControllerProcessLease } from "./runtime-control";
import {
  ServerControllerServiceManager,
  type ServerLaunchCommand,
  type ServerServiceStatus,
} from "./service-manager";
import { startServerWeb, type ServerWebRuntime } from "./web/server";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const seaShardVersion = resolveSeaShardVersion();
const developmentHostReadyTimeoutMilliseconds = 60_000;
const developmentHostReadyPollMilliseconds = 100;

interface RunOptions {
  readonly sharedDataRoot?: string;
  readonly controllerDataRoot?: string;
  readonly hostDataRoot?: string;
  readonly hostInstallerRoot?: string;
  readonly webHost?: string;
  readonly webPort?: number;
  readonly tlsCertificatePath?: string;
  readonly tlsKeyPath?: string;
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-V") {
    console.log(seaShardVersion);
    return;
  }
  if (command === "run") {
    await runServerController(parseRunOptions(arguments_));
    return;
  }
  if (command === "supervise") {
    await superviseServerController(parseRunOptions(arguments_));
    return;
  }
  if (command === "service") {
    const [action, ...serviceArguments] = arguments_;
    await runServiceCommand(action, parseRunOptions(serviceArguments));
    return;
  }
  throw new Error(`未知命令：${command}`);
}

async function runServerController(options: RunOptions): Promise<void> {
  const paths = resolveServerControllerPaths({
    ...(options.sharedDataRoot ? { userDataRoot: options.sharedDataRoot } : {}),
    ...(options.controllerDataRoot ? { controllerDataRoot: options.controllerDataRoot } : {}),
    ...(options.hostDataRoot ? { hostDataRoot: options.hostDataRoot } : {}),
  });
  const logger = await ServerControllerLogger.open(paths.logFile);
  const shutdown = installShutdownSignal();
  let runtime: SeaShardControllerRuntime | undefined;
  let localHost: ServerLocalHostConnection | undefined;
  let hostServices: ServerHostServiceGateway | undefined;
  let hostWorkers: ControllerHostWorkerDeployments | undefined;
  let stopHostWorkerReconciliation: (() => void) | undefined;
  let web: ServerWebRuntime | undefined;
  let processLease: ServerControllerProcessLease | undefined;
  let started = false;

  try {
    processLease = await ServerControllerProcessLease.acquire(paths.controllerDataRoot);
    const managedDevelopmentHost = process.env.SEASHARD_SERVER_MANAGED_DEVELOPMENT_HOST === "1";
    const hostDisposition = managedDevelopmentHost
      ? "development-source"
      : await prepareServerLocalHost({
          dataRoot: paths.hostDataRoot,
          installerRoot:
            options.hostInstallerRoot ??
            process.env.SEASHARD_SERVER_HOST_INSTALLER_ROOT ??
            join(moduleDirectory, "host-installer"),
          downloadRoot: join(paths.controllerDataRoot, "updates", "host"),
          releaseVersion: seaShardVersion,
          allowMissingInstaller: process.env.SEASHARD_SERVER_DEVELOPMENT === "1",
        });
    await logger.info(
      `SEASHARD_SERVER_HOST disposition=${hostDisposition} dataRoot=${paths.hostDataRoot}`,
    );
    if (managedDevelopmentHost) {
      localHost = await connectDevelopmentLocalHost(paths.hostDataRoot);
    } else if (hostDisposition !== "development-missing") {
      localHost = await ServerLocalHostConnection.connect({ dataRoot: paths.hostDataRoot });
    }
    if (localHost) {
      const host = localHost.snapshot();
      await logger.info(
        `SEASHARD_SERVER_HOST_CONNECTED id=${host.id} control=${host.hasControl} controllers=${host.connectedControllers} version=${host.hostVersion ?? "unknown"} packageType=${host.packageType ?? "unknown"}`,
      );
    }
    runtime = await startSeaShardController({
      dataRoot: paths.sharedControllerDataRoot,
      runtimeDataRoot: paths.controllerDataRoot,
      seaShardVersion,
      databaseWorkerEntry: resolveSiblingEntry("database-worker"),
      pluginHostEntry: resolveSiblingEntry("plugin-host"),
      hostProfile: "node",
      clientTarget: "web",
    });
    await registerServerAgentFeatures({
      kernel: runtime.kernel,
      sharedDataRoot: paths.userDataRoot,
      legacyCredentialDataRoot: paths.controllerDataRoot,
    });
    await registerAgentClientFeatures(runtime.kernel);
    await registerServerClientFeatures(runtime.kernel);
    if (localHost) {
      hostServices = await ServerHostServiceGateway.register(runtime.kernel, localHost);
      hostWorkers = new ControllerHostWorkerDeployments(runtime.kernel, () =>
        localHost?.workerDeploymentClient(),
      );
      stopHostWorkerReconciliation = runtime.kernel.onReconciled(async () => {
        try {
          await hostWorkers?.synchronize();
        } catch (error) {
          await logger.error(`Host Worker 同步失败：${formatError(error)}`);
        }
      });
      await hostWorkers.synchronize();
    }
    await runtime.kernel.start();
    const tlsCertificatePath = options.tlsCertificatePath ?? process.env.SEASHARD_SERVER_TLS_CERT;
    const tlsKeyPath = options.tlsKeyPath ?? process.env.SEASHARD_SERVER_TLS_KEY;
    if (Boolean(tlsCertificatePath) !== Boolean(tlsKeyPath)) {
      throw new Error("Server Web TLS 证书和私钥必须同时配置");
    }
    web = await startServerWeb({
      dataRoot: paths.controllerDataRoot,
      controller: runtime.kernel,
      publicRoot: process.env.SEASHARD_SERVER_WEB_PUBLIC_ROOT ?? join(moduleDirectory, "public"),
      ...(localHost ? { localHost } : {}),
      host: options.webHost ?? process.env.SEASHARD_SERVER_WEB_HOST ?? "127.0.0.1",
      port: options.webPort ?? readEnvironmentPort(process.env.SEASHARD_SERVER_WEB_PORT) ?? 18_127,
      ...(tlsCertificatePath && tlsKeyPath
        ? { tls: { certificatePath: tlsCertificatePath, keyPath: tlsKeyPath } }
        : {}),
      serviceControl: {
        token: processLease.token,
        pid: process.pid,
        startedAt: processLease.startedAt,
        requestShutdown: shutdown.request,
      },
    });
    await processLease.publish(resolveRuntimeControlUrl(web));
    await logger.info(`SEASHARD_SERVER_WEB_READY url=${web.address.url}`);
    started = true;
    await logger.info(
      `SEASHARD_SERVER_READY pid=${process.pid} dataRoot=${runtime.dataRoot} hostDataRoot=${paths.hostDataRoot}`,
    );
    process.send?.({ type: "seashard:server-ready", pid: process.pid });
    await shutdown.requested;
  } finally {
    shutdown.dispose();
    try {
      await web?.dispose();
    } finally {
      try {
        stopHostWorkerReconciliation?.();
        hostWorkers?.dispose();
        hostServices?.dispose();
        await runtime?.dispose();
      } finally {
        localHost?.dispose();
        if (started) {
          await logger.info(`SEASHARD_SERVER_STOPPED pid=${process.pid}`).catch(() => undefined);
        }
        await processLease?.release();
        await logger.close();
      }
    }
  }
}

/**
 * `dev:server` 会先启动当前工作区刚构建的 Host，再启动 Controller。Host 可能仍在建立
 * 控制端点，因此这里只负责等待；禁止回退连接正式安装目录中的 Host。
 */
async function connectDevelopmentLocalHost(dataRoot: string): Promise<ServerLocalHostConnection> {
  const deadline = Date.now() + developmentHostReadyTimeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      return await ServerLocalHostConnection.connect({ dataRoot });
    } catch (error) {
      if (!isUnavailableHostError(error)) throw error;
    }
    await delay(developmentHostReadyPollMilliseconds);
  }
  throw new Error(`源码 SeaShard Host 启动后未能发布控制端点：${dataRoot}`);
}

function isUnavailableHostError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return ["ENOENT", "ECONNREFUSED", "HOST_UNAVAILABLE", "HOST_CONNECT_TIMEOUT"].includes(
    String(error.code),
  );
}

type ServiceAction = "install" | "start" | "stop" | "restart" | "status" | "uninstall";

async function runServiceCommand(action: string | undefined, options: RunOptions): Promise<void> {
  if (!isServiceAction(action)) {
    throw new Error("service 需要 install、start、stop、restart、status 或 uninstall");
  }
  const effectiveOptions = materializeServiceRunOptions(options);
  const paths = resolveServerControllerPaths({
    userDataRoot: effectiveOptions.sharedDataRoot,
    controllerDataRoot: effectiveOptions.controllerDataRoot,
    hostDataRoot: effectiveOptions.hostDataRoot,
  });
  const launchCommand = resolveServerLaunchCommand(
    process.platform === "win32" ? "supervise" : "run",
    effectiveOptions,
  );
  const manager = new ServerControllerServiceManager({
    dataRoot: paths.controllerDataRoot,
    launch: launchCommand,
  });
  if (action === "install") {
    await manager.stop();
    await manager.install();
    console.log(`Server Controller 后台服务已安装并启动：${paths.controllerDataRoot}`);
    return;
  }
  if (action === "start") {
    await manager.start();
    console.log("Server Controller 后台服务已启动");
    return;
  }
  if (action === "stop") {
    await manager.stop();
    console.log("Server Controller 后台服务已停止");
    return;
  }
  if (action === "restart") {
    await manager.restart();
    console.log("Server Controller 后台服务已重启");
    return;
  }
  if (action === "uninstall") {
    await manager.uninstall();
    console.log(`后台服务登记已卸载，用户数据保留于：${paths.controllerDataRoot}`);
    return;
  }
  printServiceStatus(await manager.status(), paths.controllerDataRoot);
}

/**
 * Windows 任务计划只能可靠监督一个长期进程。这里把真实 Controller 作为子进程运行，
 * 异常退出按退避重新拉起；通过本机控制端点正常停机时子进程返回 0，监督器随即退出。
 */
async function superviseServerController(options: RunOptions): Promise<void> {
  const launch = resolveServerLaunchCommand("run", options);
  let child: ChildProcess | undefined;
  let stopping = false;
  let failures = 0;
  const requestStop = () => {
    stopping = true;
    child?.kill("SIGTERM");
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    while (!stopping) {
      const startedAt = Date.now();
      child = spawn(launch.executable, launch.arguments, {
        cwd: launch.workingDirectory,
        env: { ...process.env, SEASHARD_SERVER_SERVICE: "1" },
        stdio: "inherit",
        windowsHide: true,
      });
      const code = await waitForChild(child);
      child = undefined;
      if (stopping || code === 0) return;
      failures = Date.now() - startedAt >= 60_000 ? 0 : failures + 1;
      await delay(Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)));
    }
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  }
}

function resolveServerLaunchCommand(
  command: "run" | "supervise",
  options: RunOptions,
): ServerLaunchCommand {
  const executable = process.env.SEASHARD_SERVER_EXECUTABLE ?? process.execPath;
  const entry = resolve(process.argv[1] ?? executable);
  const standalone =
    process.env.SEASHARD_SERVER_STANDALONE === "1" || resolve(executable) === entry;
  return {
    executable,
    arguments: [...(standalone ? [] : [entry]), command, ...serializeRunOptions(options)],
    workingDirectory: dirname(entry),
  };
}

function materializeServiceRunOptions(options: RunOptions): RunOptions {
  const paths = resolveServerControllerPaths({
    ...(options.sharedDataRoot ? { userDataRoot: options.sharedDataRoot } : {}),
    ...(options.controllerDataRoot ? { controllerDataRoot: options.controllerDataRoot } : {}),
    ...(options.hostDataRoot ? { hostDataRoot: options.hostDataRoot } : {}),
  });
  return {
    sharedDataRoot: paths.userDataRoot,
    controllerDataRoot: paths.controllerDataRoot,
    hostDataRoot: paths.hostDataRoot,
    ...((options.hostInstallerRoot ?? process.env.SEASHARD_SERVER_HOST_INSTALLER_ROOT)
      ? {
          hostInstallerRoot:
            options.hostInstallerRoot ?? process.env.SEASHARD_SERVER_HOST_INSTALLER_ROOT,
        }
      : {}),
    webHost: options.webHost ?? process.env.SEASHARD_SERVER_WEB_HOST ?? "127.0.0.1",
    webPort: options.webPort ?? readEnvironmentPort(process.env.SEASHARD_SERVER_WEB_PORT) ?? 18_127,
    ...((options.tlsCertificatePath ?? process.env.SEASHARD_SERVER_TLS_CERT)
      ? {
          tlsCertificatePath: options.tlsCertificatePath ?? process.env.SEASHARD_SERVER_TLS_CERT,
        }
      : {}),
    ...((options.tlsKeyPath ?? process.env.SEASHARD_SERVER_TLS_KEY)
      ? { tlsKeyPath: options.tlsKeyPath ?? process.env.SEASHARD_SERVER_TLS_KEY }
      : {}),
  };
}

function serializeRunOptions(options: RunOptions): readonly string[] {
  return [
    ...(options.sharedDataRoot ? [`--shared-data-root=${options.sharedDataRoot}`] : []),
    ...(options.controllerDataRoot ? [`--data-root=${options.controllerDataRoot}`] : []),
    ...(options.hostDataRoot ? [`--host-data-root=${options.hostDataRoot}`] : []),
    ...(options.hostInstallerRoot ? [`--host-installer-root=${options.hostInstallerRoot}`] : []),
    ...(options.webHost ? [`--web-host=${options.webHost}`] : []),
    ...(options.webPort === undefined ? [] : [`--web-port=${options.webPort}`]),
    ...(options.tlsCertificatePath ? [`--tls-cert=${options.tlsCertificatePath}`] : []),
    ...(options.tlsKeyPath ? [`--tls-key=${options.tlsKeyPath}`] : []),
  ];
}

function resolveRuntimeControlUrl(web: ServerWebRuntime): string {
  if (web.address.host === "0.0.0.0" || web.address.host === "::") {
    return `${web.address.secure ? "https" : "http"}://127.0.0.1:${web.address.port}`;
  }
  return web.address.url;
}

function printServiceStatus(status: ServerServiceStatus, dataRoot: string): void {
  console.log(
    JSON.stringify(
      {
        installed: status.installed,
        running: status.running,
        dataRoot,
        ...(status.health ? { health: status.health } : {}),
      },
      null,
      2,
    ),
  );
}

function isServiceAction(action: string | undefined): action is ServiceAction {
  return (
    action === "install" ||
    action === "start" ||
    action === "stop" ||
    action === "restart" ||
    action === "status" ||
    action === "uninstall"
  );
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function resolveSiblingEntry(application: "database-worker" | "plugin-host"): string {
  const entry = join(moduleDirectory, `../../${application}/dist/index.js`);
  if (!existsSync(entry)) {
    throw new Error(`SeaShard ${application} 尚未构建：${entry}`);
  }
  return entry;
}

function parseRunOptions(arguments_: readonly string[]): RunOptions {
  let sharedDataRoot: string | undefined;
  let controllerDataRoot: string | undefined;
  let hostDataRoot: string | undefined;
  let hostInstallerRoot: string | undefined;
  let webHost: string | undefined;
  let webPort: number | undefined;
  let tlsCertificatePath: string | undefined;
  let tlsKeyPath: string | undefined;
  for (const argument of arguments_) {
    if (argument.startsWith("--shared-data-root=")) {
      sharedDataRoot = readOptionValue(argument, "--shared-data-root");
      continue;
    }
    if (argument.startsWith("--data-root=")) {
      controllerDataRoot = readOptionValue(argument, "--data-root");
      continue;
    }
    if (argument.startsWith("--host-data-root=")) {
      hostDataRoot = readOptionValue(argument, "--host-data-root");
      continue;
    }
    if (argument.startsWith("--host-installer-root=")) {
      hostInstallerRoot = readOptionValue(argument, "--host-installer-root");
      continue;
    }
    if (argument.startsWith("--web-host=")) {
      webHost = readOptionValue(argument, "--web-host");
      continue;
    }
    if (argument.startsWith("--web-port=")) {
      webPort = readPort(readOptionValue(argument, "--web-port"), "--web-port");
      continue;
    }
    if (argument.startsWith("--tls-cert=")) {
      tlsCertificatePath = readOptionValue(argument, "--tls-cert");
      continue;
    }
    if (argument.startsWith("--tls-key=")) {
      tlsKeyPath = readOptionValue(argument, "--tls-key");
      continue;
    }
    throw new Error(`未知 run 参数：${argument}`);
  }
  return {
    ...(sharedDataRoot ? { sharedDataRoot } : {}),
    ...(controllerDataRoot ? { controllerDataRoot } : {}),
    ...(hostDataRoot ? { hostDataRoot } : {}),
    ...(hostInstallerRoot ? { hostInstallerRoot } : {}),
    ...(webHost ? { webHost } : {}),
    ...(webPort === undefined ? {} : { webPort }),
    ...(tlsCertificatePath ? { tlsCertificatePath } : {}),
    ...(tlsKeyPath ? { tlsKeyPath } : {}),
  };
}

function readOptionValue(argument: string, name: string): string {
  const value = argument.slice(name.length + 1).trim();
  if (!value) throw new Error(`${name} 需要目录路径`);
  return value;
}

function readEnvironmentPort(value: string | undefined): number | undefined {
  return value === undefined ? undefined : readPort(value, "SEASHARD_SERVER_WEB_PORT");
}

function readPort(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${name} 必须是 0～65535 的整数`);
  }
  return port;
}

function installShutdownSignal(): {
  readonly requested: Promise<void>;
  readonly request: () => void;
  dispose(): void;
} {
  let resolveRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    resolveRequested = resolve;
  });
  const requestShutdown = () => resolveRequested();
  const receiveMessage = (message: unknown) => {
    if (message === "seashard:quit") requestShutdown();
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  if (process.send) {
    process.on("message", receiveMessage);
    process.once("disconnect", requestShutdown);
  }
  return {
    requested,
    request: requestShutdown,
    dispose() {
      process.off("SIGINT", requestShutdown);
      process.off("SIGTERM", requestShutdown);
      process.off("message", receiveMessage);
      process.off("disconnect", requestShutdown);
    },
  };
}

function resolveSeaShardVersion(): string {
  const environmentVersion = process.env.SEASHARD_VERSION;
  if (environmentVersion && /^\d+\.\d+\.\d+$/u.test(environmentVersion)) {
    return environmentVersion;
  }
  try {
    const metadata = JSON.parse(
      readFileSync(join(moduleDirectory, "../../../package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof metadata.version === "string" && /^\d+\.\d+\.\d+$/u.test(metadata.version)
      ? metadata.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function printHelp(): void {
  console.log(`SeaShard Server Controller ${seaShardVersion}

用法：
  seashard-server run [--shared-data-root=<目录>] [--data-root=<目录>] [--host-data-root=<目录>]
                       [--host-installer-root=<目录>] [--web-host=<地址>] [--web-port=<端口>]
                       [--tls-cert=<文件>] [--tls-key=<文件>]
  seashard-server service <install|start|stop|restart|status|uninstall> [run 参数]
  seashard-server --version
  seashard-server --help`);
}

void main().catch((error) => {
  console.error("SeaShard Server Controller 命令执行失败", error);
  process.exitCode = 1;
});
