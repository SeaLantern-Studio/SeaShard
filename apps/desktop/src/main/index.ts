import { BootstrapLoader } from "@seashard/bootstrap-runtime";
import { desktopShellContract, serverCoreIconScheme } from "@seashard/contracts";
import { createSQLiteBootstrapDescriptor } from "@seashard/database-sqlite";
import { createPluginFoundationBootstrapDescriptor } from "@seashard/plugin-foundation";
import { PluginKernel, type PluginKernelOptions } from "@seashard/plugin-system";
import { Context } from "cordis";
import { app, protocol } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerClientFeatures } from "./client-features";
import { publishServerConsoleLine, registerDesktopShellBridge } from "./desktop-shell-bridge";
import { registerHostFeatures } from "./host-features";
import { registerSmokePlugin, verifySmokeRuntime } from "./smoke";

protocol.registerSchemesAsPrivileged([
  {
    scheme: serverCoreIconScheme,
    privileges: {
      standard: true,
      secure: true,
    },
  },
]);

const smokeMode = process.env.SEASHARD_SMOKE === "1";
const developmentUrl = resolveDevelopmentUrl();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const startedAt = new Date().toISOString();
const seaShardVersion = "0.0.0";

if (developmentUrl) installDevelopmentControl();

let kernel: PluginKernel | undefined;
let bootstrapLoader: BootstrapLoader | undefined;
let shutdownTask: Promise<void> | undefined;
let shutdownComplete = false;
let stopping = false;

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
  const host = resolveHost();
  const dataRoot = process.env.SEASHARD_DATA_DIR ?? join(app.getPath("userData"), "core");
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
  await registerHostFeatures({
    kernel: activeKernel,
    root,
    dataRoot,
    seaShardVersion,
    startedAt,
    isStopping: () => stopping,
    publishServerConsoleLine,
  });
  await registerDesktopShellBridge({
    kernel: activeKernel,
    moduleDirectory,
    ...(developmentUrl ? { developmentUrl } : {}),
    smokeMode,
  });
  await registerSmokePlugin(activeKernel);
  await activeKernel.start();
  await verifySmokeRuntime(activeKernel, smokeMode);

  // 全部组件发布后再加载 Renderer，Preload 的首个调用必定命中已注册的 Shell Handler。
  await activeKernel.callService(desktopShellContract, "openPrimary", []);
  if (developmentUrl) console.log(`SEASHARD_DEV_WINDOW_READY ${developmentUrl}`);
}

async function shutdown(): Promise<void> {
  shutdownTask ??= (async () => {
    stopping = true;
    try {
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
