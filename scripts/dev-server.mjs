import { connectHostControlClient } from "../packages/host-control/src/index.ts";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = join(root, "apps/server/dist/index.js");
const hostEntry = join(root, "apps/host/dist/index.js");
const hostConfig = join(root, "apps/host/vite.config.ts");
const serverConfig = join(root, "apps/server/vite.config.ts");
const serverWebConfig = join(root, "apps/server-web/vite.config.ts");
const serverWebPublicRoot = join(root, "apps/server-web/dist");
const pluginHostConfig = join(root, "apps/plugin-host/vite.config.ts");
const databaseWorkerConfig = join(root, "apps/database-worker/vite.config.ts");
const developmentUserDataRoot = resolveDesktopDevelopmentUserDataRoot();
const developmentHostDataRoot =
  process.env.SEASHARD_HOST_DATA_DIR ??
  process.env.SEASHARD_DATA_DIR ??
  join(developmentUserDataRoot, "core");
const developmentControllerDataRoot =
  process.env.SEASHARD_SERVER_DATA_DIR ?? join(developmentUserDataRoot, "server-controller");

/**
 * Electron 开发入口的应用名为 Electron。Server 开发入口必须复用同一持久用户目录，
 * 才能连接 Desktop 已启动的 Host，并读取完全相同的服务器实例。
 */
function resolveDesktopDevelopmentUserDataRoot() {
  const homeDirectory = homedir();
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homeDirectory, "AppData", "Roaming"), "Electron");
  }
  if (process.platform === "darwin") {
    return join(homeDirectory, "Library", "Application Support", "Electron");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"), "Electron");
}

const bundleWatchers = [];
const pendingRestartSources = new Set();
let serverProcess;
let hostProcess;
let hostDataRoot;
let hostLaunchTask;
let restartTimer;
let restarting = false;
let restartQueued = false;
let stopping = false;
let restartHostQueued = false;
let shutdownTask;

async function main() {
  const records = await Promise.all([
    startBundleWatcher("server", serverConfig),
    startBundleWatcher("server-web", serverWebConfig),
    startBundleWatcher("host", hostConfig),
    startBundleWatcher("plugin-host", pluginHostConfig),
    startBundleWatcher("database-worker", databaseWorkerConfig),
  ]);
  bundleWatchers.push(...records.map((record) => record.watcher));
  await Promise.all(records.map((record) => record.initialBuild));

  await ensureDevelopmentHost(developmentHostDataRoot);
  launchServer();
  console.log("SEASHARD_SERVER_DEV_READY");
}

async function startBundleWatcher(name, configFile) {
  let buildCount = 0;
  let resolveInitialBuild;
  let rejectInitialBuild;
  const initialBuild = new Promise((resolve, reject) => {
    resolveInitialBuild = resolve;
    rejectInitialBuild = reject;
  });

  const watcher = await build({
    configFile,
    plugins: [
      {
        name: `seashard-server-dev-${name}`,
        buildEnd(error) {
          if (error && buildCount === 0) rejectInitialBuild(error);
        },
        closeBundle() {
          buildCount += 1;
          if (buildCount === 1) {
            console.log(`[server-dev] ${name} initial build complete`);
            resolveInitialBuild();
            return;
          }
          scheduleServerRestart(name, ["host", "plugin-host", "database-worker"].includes(name));
        },
      },
    ],
    build: {
      watch: {},
    },
  });

  if (!watcher || Array.isArray(watcher) || typeof watcher.close !== "function") {
    throw new Error(`${name} build did not return a watcher`);
  }
  return { watcher, initialBuild };
}

function launchServer() {
  const child = spawn(process.execPath, [serverEntry, "run"], {
    cwd: root,
    env: {
      ...process.env,
      SEASHARD_SERVER_DEVELOPMENT: "1",
      SEASHARD_SERVER_WEB_PUBLIC_ROOT: serverWebPublicRoot,
      SEASHARD_HOST_DATA_DIR: developmentHostDataRoot,
      SEASHARD_SHARED_DATA_DIR: developmentUserDataRoot,
      SEASHARD_SERVER_DATA_DIR: developmentControllerDataRoot,
      SEASHARD_SERVER_MANAGED_DEVELOPMENT_HOST: "1",
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  serverProcess = child;
  console.log(`SEASHARD_SERVER_DEV_STARTED pid=${child.pid}`);

  child.once("error", (error) => {
    console.error("[server-dev] Server Controller failed to start", error);
    void shutdown(1);
  });
  child.once("exit", (code, signal) => {
    if (serverProcess === child) serverProcess = undefined;
    if (stopping || restarting) return;
    const detail = code === null ? `signal ${signal}` : `code ${code}`;
    console.error(`[server-dev] Server Controller exited with ${detail}`);
    void shutdown(code ?? 1);
  });
}

async function ensureDevelopmentHost(dataRoot) {
  if (hostProcess && hostProcess.exitCode === null && hostProcess.signalCode === null) {
    if (hostDataRoot !== dataRoot) {
      return Promise.reject(
        new Error(`development Host already owns ${hostDataRoot}; cannot also open ${dataRoot}`),
      );
    }
    return Promise.resolve();
  }
  if (hostLaunchTask) {
    if (hostDataRoot !== dataRoot) {
      return Promise.reject(
        new Error(`development Host is starting for ${hostDataRoot}; cannot also open ${dataRoot}`),
      );
    }
    return hostLaunchTask;
  }
  if (await canReuseDevelopmentHost(dataRoot)) {
    console.log(`SEASHARD_SERVER_DEV_HOST_REUSED dataRoot=${dataRoot}`);
    return;
  }

  hostDataRoot = dataRoot;
  const child = spawn(process.execPath, [hostEntry], {
    cwd: root,
    env: {
      ...process.env,
      SEASHARD_HOST_DATA_DIR: dataRoot,
      SEASHARD_HOST_INSTALLATION_KIND: "standalone",
      SEASHARD_VERSION: "0.0.0",
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  hostProcess = child;
  console.log(`SEASHARD_SERVER_DEV_HOST_STARTED pid=${child.pid} dataRoot=${dataRoot}`);
  hostLaunchTask = waitForChildSpawn(child);
  child.once("exit", (code, signal) => {
    if (hostProcess !== child) return;
    hostProcess = undefined;
    hostDataRoot = undefined;
    hostLaunchTask = undefined;
    if (stopping || restarting) return;
    const detail = code === null ? `signal ${signal}` : `code ${code}`;
    console.error(`[server-dev] development Host exited with ${detail}`);
    void shutdown(code ?? 1);
  });
  return hostLaunchTask;
}

function waitForChildSpawn(child) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}
async function canReuseDevelopmentHost(dataRoot) {
  try {
    const client = await connectHostControlClient({
      dataRoot,
      identity: {
        sessionId: `server-dev-host-probe-${process.pid}`,
        label: "Server development runner",
      },
    });
    client.dispose();
    return true;
  } catch {
    return false;
  }
}

function scheduleServerRestart(source, restartHost = false) {
  if (stopping) return;
  restartHostQueued ||= restartHost;
  pendingRestartSources.add(source);
  if (restarting) {
    restartQueued = true;
    return;
  }
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    void restartServer();
  }, 120);
}

async function restartServer() {
  if (stopping) return;
  if (restarting) {
    restartQueued = true;
    return;
  }

  restarting = true;
  const sources = [...pendingRestartSources]
    .sort((left, right) => left.localeCompare(right))
    .join(", ");
  pendingRestartSources.clear();
  const restartHost = restartHostQueued;
  restartQueued = false;
  restartHostQueued = false;
  console.log(`[server-dev] restarting Server Controller after ${sources} rebuild`);

  await stopManagedChild(serverProcess);
  if (restartHost) {
    await stopManagedChild(hostProcess);
    hostProcess = undefined;
    hostDataRoot = undefined;
    hostLaunchTask = undefined;
  }
  if (!stopping) {
    if (restartHost) await ensureDevelopmentHost(developmentHostDataRoot);
    launchServer();
  }

  restarting = false;
  if (restartQueued || pendingRestartSources.size > 0) scheduleServerRestart("queued");
}

function stopManagedChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const forceTimer = setTimeout(() => child.kill(), 3_000);
    child.once("exit", () => {
      clearTimeout(forceTimer);
      resolve();
    });
    if (child.connected) {
      child.send("seashard:quit", (error) => {
        if (error) child.kill();
      });
    } else {
      child.kill();
    }
  });
}

function shutdown(exitCode = 0) {
  if (shutdownTask) return shutdownTask;
  stopping = true;
  clearTimeout(restartTimer);
  shutdownTask = (async () => {
    restarting = true;
    await stopManagedChild(serverProcess);
    await stopManagedChild(hostProcess);
    hostProcess = undefined;
    hostDataRoot = undefined;
    hostLaunchTask = undefined;
    await Promise.all(bundleWatchers.map((watcher) => watcher.close()));
    process.exitCode = exitCode;
  })();
  return shutdownTask;
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

void main().catch((error) => {
  console.error("[server-dev] startup failed", error);
  void shutdown(1);
});
