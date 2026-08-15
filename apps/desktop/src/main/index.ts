import { createDesktopGatewayModule, desktopGatewayManifest } from "@seashard/desktop-gateway";
import type { RuntimeSnapshot } from "@seashard/contracts";
import type { RuntimeControlSnapshot, RuntimeGenerationSnapshot } from "@seashard/plugin-sdk";
import {
  PluginKernel,
  type PluginKernelOptions,
  type PluginPackageRecord,
} from "@seashard/plugin-system";
import { app, BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const smokeMode = process.env.SEASHARD_SMOKE === "1";
const developmentUrl = resolveDevelopmentUrl();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const startedAt = new Date().toISOString();

if (developmentUrl) installDevelopmentControl();

let mainWindow: BrowserWindow | null = null;
let kernel: PluginKernel | undefined;
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
  kernel = await PluginKernel.create({
    dataRoot,
    seaShardVersion: "0.0.0",
    pluginHostEntry: join(moduleDirectory, "../../../plugin-host/dist/index.js"),
    hostProfile: "electron",
    clientTarget: "desktop",
    platform: host.platform,
    architecture: host.architecture,
  });
  if (smokeMode) {
    kernel.registerCoreService("seashard.smoke.marker", {
      prefix(value) {
        if (typeof value !== "string") throw new TypeError("smoke marker must be a string");
        return `core-${value}`;
      },
    });
  }
  kernel.registerBuiltIn({
    manifest: desktopGatewayManifest,
    loaders: {
      "desktop-gateway.host": {
        load: async () =>
          createDesktopGatewayModule({
            authorize: (event) => event.sender === mainWindow?.webContents,
            getRuntimeSnapshot,
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
    const before = publishedGeneration(kernel.runtimeSnapshot(), "smoke.external-plugin");
    await kernel.reload("smoke.external-plugin");
    const after = publishedGeneration(kernel.runtimeSnapshot(), "smoke.external-plugin");
    const reloadedEcho = await kernel.callService("seashard.smoke.echo", "echo", ["reload"]);
    if (
      !before ||
      !after ||
      after.generation <= before.generation ||
      after.phase !== "running" ||
      reloadedEcho !== "core-smoke:reload" ||
      kernel.diagnostics().contributions !== 1
    ) {
      throw new Error("external plugin reload did not preserve a single published generation");
    }
    console.log(`SEASHARD_PLUGIN_SMOKE_ECHO ${echo}`);
    console.log(
      `SEASHARD_PLUGIN_SMOKE_RELOADED before=${before.generation} after=${after.generation}`,
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
  pluginKernel.registry.selectPackageVersion(record);
  const entry = record.manifest.entries.find((candidateEntry) => candidateEntry.runtime === "host");
  if (!entry) throw new Error("smoke plugin must contain a host entry");
  pluginKernel.upsertBinding({
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

function getRuntimeSnapshot(): RuntimeSnapshot {
  const control = kernel?.runtimeSnapshot() ?? {
    generations: [],
    publications: [],
    operations: [],
  };
  const components = projectComponents(control);
  return {
    protocolVersion: 1,
    host: "electron",
    state:
      stopping || components.some((component) => component.phase === "failed")
        ? "degraded"
        : "active",
    startedAt,
    components,
  };
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

function projectComponents(snapshot: RuntimeControlSnapshot): RuntimeSnapshot["components"] {
  const publications = new Map(
    snapshot.publications.map((publication) => [publication.runtimeId, publication]),
  );
  const operations = new Map(
    snapshot.operations.map((operation) => [operation.runtimeId, operation]),
  );
  const latest = new Map<string, (typeof snapshot.generations)[number]>();
  for (const generation of snapshot.generations) {
    const current = latest.get(generation.runtimeId);
    if (!current || current.generation < generation.generation) {
      latest.set(generation.runtimeId, generation);
    }
  }

  return [...latest.values()]
    .flatMap((generation) => {
      const publication = publications.get(generation.runtimeId);
      const published =
        publication?.generation === null || publication?.generation === undefined
          ? undefined
          : snapshot.generations.find(
              (candidate) =>
                candidate.runtimeId === generation.runtimeId &&
                candidate.generation === publication.generation,
            );
      const operation = operations.get(generation.runtimeId);
      if (!published && generation.phase === "terminated" && operation?.status === "completed") {
        return [];
      }
      const phase =
        published?.phase === "running"
          ? ("active" as const)
          : operation?.status === "running"
            ? operation.step === "wait-dependencies"
              ? ("blocked" as const)
              : ("updating" as const)
            : ("failed" as const);
      const displayed = published ?? generation;
      return [
        {
          id: displayed.runtimeId,
          displayName: `${displayed.pluginId}/${displayed.entryId}`,
          generation: displayed.generation,
          phase,
          ...(operation?.error ? { error: operation.error } : {}),
        },
      ];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function shutdown(): Promise<void> {
  shutdownTask ??= (async () => {
    stopping = true;
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
