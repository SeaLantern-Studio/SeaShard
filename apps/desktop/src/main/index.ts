import { BootstrapLoader } from "@seashard/bootstrap-runtime";
import { createDesktopGatewayModule, desktopGatewayManifest } from "@seashard/desktop-gateway";
import { createSQLiteBootstrapDescriptor } from "@seashard/database-sqlite";
import { createSQLitePluginStorageBootstrapDescriptor } from "@seashard/plugin-storage-sqlite";
import { createPluginSystemFoundationBootstrapDescriptor } from "@seashard/plugin-system-foundation";
import type { RuntimeControlSnapshot, RuntimeGenerationSnapshot } from "@seashard/plugin-sdk";
import {
  PluginKernel,
  type PluginKernelOptions,
  type PluginPackageRecord,
} from "@seashard/plugin-system";
import {
  createRuntimeDiagnosticsModule,
  runtimeDiagnosticsManifest,
} from "@seashard/runtime-diagnostics";
import { Context } from "cordis";
import { app, BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const smokeMode = process.env.SEASHARD_SMOKE === "1";
const developmentUrl = resolveDevelopmentUrl();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const startedAt = new Date().toISOString();
const seaShardVersion = "0.0.0";

if (developmentUrl) installDevelopmentControl();

let mainWindow: BrowserWindow | null = null;
let kernel: PluginKernel | undefined;
let bootstrapLoader: BootstrapLoader | undefined;
let shutdownTask: Promise<void> | undefined;
let shutdownComplete = false;
let smokeQuitScheduled = false;
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
    createSQLitePluginStorageBootstrapDescriptor({
      dataRoot,
      workerEntry: databaseWorkerEntry,
    }),
    createPluginSystemFoundationBootstrapDescriptor({ seaShardVersion }),
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
    store: root["plugin-system-foundation"].store,
    pluginStorage: root["plugin-storage"],
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
  // 运行诊断属于第二阶段可重载组件。Main 只注入原始控制快照和宿主状态，不复制投影策略。
  await activeKernel.registerBuiltIn({
    manifest: runtimeDiagnosticsManifest,
    loaders: {
      "runtime-diagnostics.host": {
        load: async () =>
          createRuntimeDiagnosticsModule({
            host: "electron",
            startedAt,
            readControlSnapshot: () => activeKernel.runtimeSnapshot(),
            isStopping: () => stopping,
          }),
      },
    },
    bindings: [
      {
        id: "core.runtime-diagnostics",
        entryId: "runtime-diagnostics.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // Gateway 通过 Service 依赖诊断组件；实际启动顺序由 Supervisor 的依赖图决定。
  await activeKernel.registerBuiltIn({
    manifest: desktopGatewayManifest,
    loaders: {
      "desktop-gateway.host": {
        load: async () =>
          createDesktopGatewayModule({
            authorize: (event) => event.sender === mainWindow?.webContents,
            onRuntimeSnapshotServed: (snapshot) => {
              if (!smokeMode || smokeQuitScheduled) return;
              smokeQuitScheduled = true;
              console.log(`SEASHARD_SMOKE_READY components=${snapshot.components.length}`);
              setTimeout(() => app.quit(), 50).unref();
            },
          }),
      },
    },
    bindings: [
      {
        id: "core.desktop-gateway",
        entryId: "desktop-gateway.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  await registerSmokePlugin(kernel);
  await kernel.start();
  if (process.env.SEASHARD_SMOKE_EXPECT_PLUGIN === "1") {
    const echo = await kernel.callService("seashard.smoke.echo", "echo", ["probe"]);
    if (echo !== "core-smoke:probe") {
      throw new Error(
        `external plugin service returned unexpected value: ${JSON.stringify(echo) ?? "undefined"}`,
      );
    }
    const activationBefore = await kernel.callService("seashard.smoke.echo", "activationCount", []);
    const before = publishedGeneration(kernel.runtimeSnapshot(), "smoke.external-plugin");
    await kernel.reload("smoke.external-plugin");
    const after = publishedGeneration(kernel.runtimeSnapshot(), "smoke.external-plugin");
    const reloadedEcho = await kernel.callService("seashard.smoke.echo", "echo", ["reload"]);
    const activationAfter = await kernel.callService("seashard.smoke.echo", "activationCount", []);
    if (
      !before ||
      !after ||
      after.generation <= before.generation ||
      after.phase !== "running" ||
      reloadedEcho !== "core-smoke:reload" ||
      typeof activationBefore !== "number" ||
      typeof activationAfter !== "number" ||
      activationAfter !== activationBefore + 1 ||
      kernel.diagnostics().contributions !== 1
    ) {
      throw new Error("external plugin reload did not preserve a single published generation");
    }
    console.log(`SEASHARD_PLUGIN_SMOKE_ECHO ${echo}`);
    console.log(
      `SEASHARD_PLUGIN_SMOKE_RELOADED before=${before.generation} after=${after.generation}`,
    );
    console.log(
      `SEASHARD_PLUGIN_SMOKE_STORAGE before=${activationBefore} after=${activationAfter}`,
    );
  }

  mainWindow = createWindow();
  await loadRenderer(mainWindow);
  if (developmentUrl) console.log(`SEASHARD_DEV_WINDOW_READY ${developmentUrl}`);
}

async function registerSmokePlugin(pluginKernel: PluginKernel): Promise<void> {
  const archivePath = process.env.SEASHARD_SMOKE_PLUGIN_ARCHIVE;
  const sourceRoot = process.env.SEASHARD_SMOKE_PLUGIN_DIR;
  if (!archivePath && !sourceRoot) return;

  let record: PluginPackageRecord;
  if (archivePath) {
    const prepared = await pluginKernel.prepareArchive(archivePath);
    let rejected = false;
    try {
      await prepared.commit({
        digest: "0".repeat(64),
        acknowledgeFullMachineAccess: true,
      });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("plugin archive accepted a trust grant for the wrong digest");
    console.log("SEASHARD_PLUGIN_SMOKE_TRUST_REJECTED");
    record = await prepared.commit({
      digest: prepared.digest,
      acknowledgeFullMachineAccess: true,
    });
  } else {
    const candidate = await pluginKernel.installer.inspectDevelopmentDirectory(sourceRoot!);
    record = await pluginKernel.installDevelopmentDirectory(sourceRoot!, {
      digest: candidate.digest,
      acknowledgeFullMachineAccess: true,
    });
  }
  await pluginKernel.registry.selectPackageVersion(record);
  const entry = record.manifest.entries.find((candidateEntry) => candidateEntry.runtime === "host");
  if (!entry) throw new Error("smoke plugin must contain a host entry");
  await pluginKernel.upsertBinding({
    id: "smoke.external-plugin",
    pluginId: record.manifest.id,
    entryId: entry.id,
    scopeType: "global",
    scopeId: "global",
    enabled: true,
    config: { marker: "smoke" },
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f3f1eb",
    webPreferences: {
      preload: join(moduleDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  window.once("ready-to-show", () => {
    if (!smokeMode) window.show();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  return window;
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  if (developmentUrl) {
    await window.loadURL(developmentUrl);
    return;
  }
  await window.loadFile(join(moduleDirectory, "../renderer/index.html"));
}

function publishedGeneration(
  snapshot: RuntimeControlSnapshot,
  runtimeId: string,
): RuntimeGenerationSnapshot | undefined {
  const publication = snapshot.publications.find((candidate) => candidate.runtimeId === runtimeId);
  if (publication?.generation === null || publication?.generation === undefined) return undefined;
  return snapshot.generations.find(
    (generation) =>
      generation.runtimeId === runtimeId && generation.generation === publication.generation,
  );
}

async function shutdown(): Promise<void> {
  shutdownTask ??= (async () => {
    stopping = true;
    try {
      await kernel?.dispose();
      const activeUnits =
        kernel
          ?.runtimeSnapshot()
          .publications.filter((publication) => publication.generation !== null).length ?? 0;
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

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && kernel) {
    mainWindow = createWindow();
    void loadRenderer(mainWindow);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

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
