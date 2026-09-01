import { ensureStandaloneHostAutostart, resolveDefaultHostDataRoot } from "./autostart";
import { registerStandaloneHost } from "@seashard/host-installation";
import { startSeaShardHost, type SeaShardHostRuntime } from "@seashard/host-runtime";
import { existsSync } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const shutdownRequestFileName = "host-shutdown.request";
let runtime: SeaShardHostRuntime | undefined;
let shutdownTask: Promise<void> | undefined;
let activeDataRoot: string | undefined;
let shutdownRequestWatcher: FSWatcher | undefined;

async function main(): Promise<void> {
  const dataRoot =
    readArgument("--data-root") ??
    process.env.SEASHARD_HOST_DATA_DIR ??
    resolveDefaultHostDataRoot();
  await registerStandaloneHost(dataRoot);
  activeDataRoot = dataRoot;
  await ensureStandaloneHostAutostart({ dataRoot }).catch((error) => {
    // 启动登记属于安装便利能力；失败时保留当前 Host 进程，交给 Controller 展示连接事实。
    console.warn("SeaShard Host autostart registration failed", error);
  });

  runtime = await startSeaShardHost({
    dataRoot,
    seaShardVersion: process.env.SEASHARD_VERSION ?? "0.0.0",
    databaseWorkerEntry: resolveHostSiblingEntry("database-worker"),
    pluginHostEntry: resolveHostSiblingEntry("plugin-host"),
    hostProfile: "node",
    requestShutdown: () => void shutdown(),
  });
  shutdownRequestWatcher = await installShutdownRequestWatcher(dataRoot);

  installShutdownSignals();
  console.log(`SEASHARD_HOST_READY pid=${process.pid} dataRoot=${runtime.dataRoot}`);
  process.send?.({ type: "seashard:host-ready", pid: process.pid });
}

function resolveHostSiblingEntry(application: "database-worker" | "plugin-host"): string {
  const resourcesPath = process.resourcesPath;
  if (resourcesPath) {
    const unpackedEntry = join(
      resourcesPath,
      "app.asar.unpacked",
      "apps",
      application,
      "dist",
      "index.js",
    );
    if (existsSync(unpackedEntry)) return unpackedEntry;
  }
  return join(moduleDirectory, `../../${application}/dist/index.js`);
}

function readArgument(name: string): string | undefined {
  const prefix = `${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  const value = argument?.slice(prefix.length);
  return value || undefined;
}

async function installShutdownRequestWatcher(dataRoot: string): Promise<FSWatcher> {
  await mkdir(dataRoot, { recursive: true });
  const requestPath = join(dataRoot, shutdownRequestFileName);
  await rm(requestPath, { force: true });
  const inspectRequest = async () => {
    try {
      await stat(requestPath);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    void shutdown();
  };
  const watcher = watch(dataRoot, (_event, fileName) => {
    if (fileName && fileName.toString() !== shutdownRequestFileName) return;
    void inspectRequest().catch((error) => {
      console.error("SeaShard Host shutdown request failed", error);
    });
  });
  watcher.on("error", (error) => {
    console.error("SeaShard Host shutdown watcher failed", error);
  });
  return watcher;
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function installShutdownSignals(): void {
  const requestShutdown = () => void shutdown();
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  if (process.send) {
    process.on("message", (message: unknown) => {
      if (message === "seashard:quit") requestShutdown();
    });
    // 开发与冒烟模式使用父子 IPC；父进程异常退出时也完整释放描述文件和数据租约。
    process.once("disconnect", requestShutdown);
  }
}

function shutdown(): Promise<void> {
  shutdownTask ??= (async () => {
    const activeRuntime = runtime;
    const dataRoot = activeDataRoot;
    runtime = undefined;
    activeDataRoot = undefined;
    shutdownRequestWatcher?.close();
    shutdownRequestWatcher = undefined;
    try {
      await activeRuntime?.dispose();
    } finally {
      if (dataRoot) await rm(join(dataRoot, shutdownRequestFileName), { force: true });
    }
    console.log(`SEASHARD_HOST_STOPPED pid=${process.pid}`);
  })()
    .catch((error) => {
      console.error("SeaShard Host shutdown failed", error);
      process.exitCode = 1;
    })
    .finally(() => {
      if (process.connected) process.disconnect?.();
    });
  return shutdownTask;
}

void main().catch((error) => {
  console.error("SeaShard Host command failed", error);
  if (runtime) {
    void shutdown().finally(() => {
      process.exitCode = 1;
    });
  } else {
    process.exitCode = 1;
  }
});
