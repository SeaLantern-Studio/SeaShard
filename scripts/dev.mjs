import electronExecutable from "electron";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const electronEntry = join(root, "apps/desktop/dist/main/index.js");
const mainConfig = join(root, "apps/desktop/vite.main.config.ts");
const preloadConfig = join(root, "apps/desktop/vite.preload.config.ts");
const pluginHostConfig = join(root, "apps/plugin-host/vite.config.ts");
const rendererConfig = join(root, "vite.config.ts");

const bundleWatchers = [];
const pendingRestartSources = new Set();
let rendererServer;
let electronProcess;
let restartTimer;
let restarting = false;
let restartQueued = false;
let stopping = false;
let shutdownTask;

async function main() {
  rendererServer = await createServer({ configFile: rendererConfig });
  await rendererServer.listen();

  const rendererUrl = rendererServer.resolvedUrls?.local[0];
  if (!rendererUrl) {
    throw new Error("Vite did not expose a local renderer URL");
  }

  console.log(`[dev] renderer listening at ${rendererUrl}`);

  const records = await Promise.all([
    startBundleWatcher("main", mainConfig),
    startBundleWatcher("preload", preloadConfig),
    startBundleWatcher("plugin-host", pluginHostConfig),
  ]);
  bundleWatchers.push(...records.map((record) => record.watcher));
  await Promise.all(records.map((record) => record.initialBuild));

  launchElectron(rendererUrl);
  console.log(`SEASHARD_DEV_READY ${rendererUrl}`);
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
        name: `seashard-dev-${name}`,
        buildEnd(error) {
          if (error && buildCount === 0) rejectInitialBuild(error);
        },
        closeBundle() {
          buildCount += 1;
          if (buildCount === 1) {
            console.log(`[dev] ${name} initial build complete`);
            resolveInitialBuild();
            return;
          }
          scheduleElectronRestart(name);
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

function launchElectron(rendererUrl) {
  const child = spawn(
    electronExecutable,
    [electronEntry, `--seashard-dev-server-url=${rendererUrl}`],
    {
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );

  electronProcess = child;
  console.log(`SEASHARD_DEV_ELECTRON_STARTED pid=${child.pid}`);

  child.once("error", (error) => {
    console.error("[dev] Electron failed to start", error);
    void shutdown(1);
  });
  child.once("exit", (code, signal) => {
    if (electronProcess === child) electronProcess = undefined;
    if (stopping || restarting) return;

    const detail = code === null ? `signal ${signal}` : `code ${code}`;
    console.log(`[dev] Electron exited with ${detail}`);
    void shutdown(code ?? 0);
  });
}

function scheduleElectronRestart(source) {
  if (stopping) return;
  pendingRestartSources.add(source);
  if (restarting) {
    restartQueued = true;
    return;
  }

  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    void restartElectron();
  }, 120);
}

async function restartElectron() {
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
  restartQueued = false;
  console.log(`[dev] restarting Electron after ${sources} rebuild`);

  await stopElectron(electronProcess);
  if (!stopping && rendererServer) {
    const rendererUrl = rendererServer.resolvedUrls?.local[0];
    if (!rendererUrl) throw new Error("renderer URL disappeared during restart");
    launchElectron(rendererUrl);
  }

  restarting = false;
  if (restartQueued || pendingRestartSources.size > 0) {
    scheduleElectronRestart("queued");
  }
}

function stopElectron(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      child.kill();
    }, 2_000);

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
    await stopElectron(electronProcess);
    await Promise.all(bundleWatchers.map((watcher) => watcher.close()));
    await rendererServer?.close();
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
  console.error("[dev] startup failed", error);
  void shutdown(1);
});
