import { watch } from "chokidar";
import { relative, resolve, sep } from "node:path";
import {
  createControlLaunch,
  launchDeveloperHost,
  sendControl,
  stopDeveloperHost,
} from "../host-control";
import { buildPluginProject, validatePluginDirectory } from "../plugin-project";

export async function developPlugin(directory: string): Promise<void> {
  const root = resolve(directory);
  const builtByCli = await buildPluginProject(root, { optional: true });
  const initial = await validatePluginDirectory(root);
  const launch = await createControlLaunch("development", root);
  const host = await launchDeveloperHost(launch);

  console.log(
    `Development Host ready for ${initial.candidate.manifest.id}@${initial.candidate.manifest.version}`,
  );
  if (host.descriptor.runtimeIds.length) {
    console.log(`Runtimes: ${host.descriptor.runtimeIds.join(", ")}`);
  } else {
    console.log("Runtimes: no Host runtime");
  }

  const watcher = watch(root, {
    ignoreInitial: true,
    ignored: (path) => shouldIgnore(path, root, builtByCli),
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 25 },
  });
  let refreshTimer: NodeJS.Timeout | undefined;
  let refreshTask = Promise.resolve();
  let stopping = false;

  const scheduleRefresh = () => {
    if (stopping) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTask = refreshTask.then(refresh).catch((error) => {
        console.error(`[plugin dev] ${formatError(error)}`);
      });
    }, 120);
  };
  watcher.on("add", scheduleRefresh);
  watcher.on("change", scheduleRefresh);
  watcher.on("unlink", scheduleRefresh);

  const refresh = async () => {
    if (builtByCli) await buildPluginProject(root);
    await validatePluginDirectory(root);
    // Host 重新检查摘要、Manifest 和 Entry，并用一次 reconcile 替换完整开发注册。
    const snapshot = await sendControl(host.descriptor, "refresh", {});
    const selected = snapshot.runtime.plugins.filter((plugin) =>
      snapshot.session.runtimeIds.includes(plugin.runtimeId),
    );
    const states = selected.length
      ? selected.map((plugin) => `${plugin.runtimeId}:${plugin.state}`).join(", ")
      : "no Host runtime";
    console.log(`[plugin dev] ${new Date().toISOString()} ${states}`);
  };

  await new Promise<void>((resolvePromise, reject) => {
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(refreshTimer);
      void watcher
        .close()
        .then(() => refreshTask)
        .then(() => stopDeveloperHost(host))
        .then(resolvePromise, reject);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (stopping) return;
      stopping = true;
      clearTimeout(refreshTimer);
      void watcher.close().then(() => {
        if (code === 0) resolvePromise();
        else {
          reject(
            new Error(
              `Development Host exited (${code === null ? `signal ${signal}` : `code ${code}`})`,
            ),
          );
        }
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    host.child.once("exit", onExit);
  });
}

function shouldIgnore(path: string, root: string, builtByCli: boolean): boolean {
  const child = relative(root, path).split(sep).join("/");
  if (!child) return false;
  const first = child.split("/", 1)[0];
  if (first === ".git" || first === "node_modules") return true;
  if (builtByCli && first === "dist") return true;
  return child.endsWith(".seashard-plugin");
}

function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
