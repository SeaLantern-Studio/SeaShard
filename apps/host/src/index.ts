import {
  ensureStandaloneHostAutostart,
  resolveDefaultHostDataRoot,
  resolveHostPackageType,
} from "./autostart";
import { registerStandaloneHost } from "@seashard/host-installation";
import { startSeaShardHost, type SeaShardHostRuntime } from "@seashard/host-runtime";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const seaShardVersion = resolveSeaShardVersion();
const shutdownRequestFileName = "host-shutdown.request";
const hostPackageType = resolveHostPackageType();
let runtime: SeaShardHostRuntime | undefined;
let shutdownTask: Promise<void> | undefined;
let activeDataRoot: string | undefined;
let shutdownRequestWatcher: FSWatcher | undefined;

async function main(): Promise<void> {
  const dataRoot =
    readArgument("--data-root") ??
    process.env.SEASHARD_HOST_DATA_DIR ??
    resolveDefaultHostDataRoot();
  await registerStandaloneHost(dataRoot, hostPackageType);
  await registerLinuxComponentUninstaller().catch((error) => {
    // Host 的运行优先于卸载入口登记；登记失败仍保留可用的 Host，并把原因写入日志。
    console.warn("SeaShard component uninstaller registration failed", error);
  });
  activeDataRoot = dataRoot;
  await ensureStandaloneHostAutostart({ dataRoot }).catch((error) => {
    // 启动登记属于安装便利能力；失败时保留当前 Host 进程，交给 Controller 展示连接事实。
    console.warn("SeaShard Host autostart registration failed", error);
  });

  runtime = await startSeaShardHost({
    dataRoot,
    seaShardVersion,
    databaseWorkerEntry: resolveHostSiblingEntry("database-worker"),
    packageType: hostPackageType,
    pluginHostEntry: resolveHostSiblingEntry("plugin-host"),
    hostProfile: "node",
    requestShutdown: () => void shutdown(),
  });
  shutdownRequestWatcher = await installShutdownRequestWatcher(dataRoot);

  installShutdownSignals();
  console.log(`SEASHARD_HOST_READY pid=${process.pid} dataRoot=${runtime.dataRoot}`);
  process.send?.({ type: "seashard:host-ready", pid: process.pid });
}
async function registerLinuxComponentUninstaller(): Promise<void> {
  if (process.platform !== "linux") return;
  const script = join(process.resourcesPath, "uninstaller", "uninstall-seashard.sh");
  if (!existsSync(script)) return;

  await new Promise<void>((resolve, reject) => {
    const child = spawn("/bin/sh", [script, "--register-host"], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorOutput = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-16_384);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          errorOutput.trim() ||
            (signal
              ? `SeaShard 卸载器登记进程被信号 ${signal} 中止`
              : `SeaShard 卸载器登记进程退出码为 ${code ?? "unknown"}`),
        ),
      );
    });
  });
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

/** electron-builder 会把 Release 版本写入 app.asar 根 package.json；开发环境继续使用 0.0.0。 */
function resolveSeaShardVersion(): string {
  const environmentVersion = process.env.SEASHARD_VERSION;
  if (environmentVersion) return environmentVersion;
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
