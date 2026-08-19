import { aboutUiManifest } from "@seashard/about-ui";
import { BootstrapLoader } from "@seashard/bootstrap-runtime";
import {
  desktopShellContract,
  serverCoreIconHost,
  serverCoreIconScheme,
  serverInstanceIconHost,
  serverDownloadConnectionLimits,
  serverJvmArgumentsMaximumLength,
  serverPortLimits,
  javaRuntimeManagerContract,
  serverConfigurationContract,
  serverRuntimeContract,
  serverSettingsContract,
  type JavaInstallationSnapshot,
  type JavaInstallationSource,
  type ServerConsoleLine,
  type ServerConfigurationCatalog,
  type ServerConfigurationDocument,
  type ServerConfigurationFile,
  type ServerConfigurationWriteRequest,
  type ServerCoreArtifact,
  type ServerCoreDownloadTaskSnapshot,
  type ServerCoreManagedDownloadResult,
  type ServerInstanceSnapshot,
  type ServerCoreType,
  type ServerRuntimeSnapshot,
  type ServerSettingsSnapshot,
  type ServerStartupDefaultsUpdate,
} from "@seashard/contracts";
import { createSQLiteBootstrapDescriptor } from "@seashard/database-sqlite";
import { createDownloadModule, downloadManifest } from "@seashard/download";
import {
  createDesktopShellModule,
  createElectronDesktopShellRuntime,
  desktopShellManifest,
} from "@seashard/desktop-shell";
import { gameSettingsUiManifest } from "@seashard/game-settings-ui";
import {
  createJavaRuntimeManagerModule,
  javaRuntimeManagerManifest,
} from "@seashard/java-runtime-manager";
import { personalizationUiManifest } from "@seashard/personalization-ui";
import { createPluginFoundationBootstrapDescriptor } from "@seashard/plugin-foundation";
import type {
  JsonValue,
  RuntimeControlSnapshot,
  RuntimeGenerationSnapshot,
} from "@seashard/plugin-sdk";
import {
  PluginKernel,
  projectClientEntryPublication,
  type PluginKernelOptions,
  type PluginPackageRecord,
} from "@seashard/plugin-system";
import {
  createRuntimeDiagnosticsModule,
  runtimeDiagnosticsManifest,
} from "@seashard/runtime-diagnostics";
import { runtimeDiagnosticsUiManifest } from "@seashard/runtime-diagnostics-ui";
import {
  createServerCoreSourceModule,
  serverCoreSourceContract,
  serverCoreSourceManifest,
} from "@seashard/server-core-source";
import {
  createServerConfigurationModule,
  serverConfigurationManifest,
} from "@seashard/server-configuration";
import {
  createServerInstanceManagerModule,
  serverInstanceManagerContract,
  serverInstanceManagerManifest,
} from "@seashard/server-instance-manager";
import { createServerRuntimeModule, serverRuntimeManifest } from "@seashard/server-runtime";
import { serverDownloadUiManifest } from "@seashard/server-download-ui";
import { serverLaunchUiManifest } from "@seashard/server-launch-ui";
import { serverSettingsUiManifest } from "@seashard/server-settings-ui";
import { createServerSettingsModule, serverSettingsManifest } from "@seashard/server-settings";
import { Context } from "cordis";
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from "electron";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const downloadFetchProvider = () => globalThis.fetch;

if (developmentUrl) installDevelopmentControl();

let kernel: PluginKernel | undefined;
let bootstrapLoader: BootstrapLoader | undefined;
let shutdownTask: Promise<void> | undefined;
let shutdownComplete = false;
let smokeQuitScheduled = false;
let stopping = false;
const serverConsoleLineListeners = new Set<(line: ServerConsoleLine) => void>();

/** 把运行组件的增量日志发布给当前 Desktop Shell，不让组件直接依赖 Electron。 */
function publishServerConsoleLine(line: ServerConsoleLine): void {
  for (const listener of serverConsoleLineListeners) {
    try {
      listener({ ...line });
    } catch (error) {
      console.error("Server console listener failed", error);
    }
  }
}

function onServerConsoleLine(listener: (line: ServerConsoleLine) => void): () => void {
  serverConsoleLineListeners.add(listener);
  return () => serverConsoleLineListeners.delete(listener);
}

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

function isServerCoreIconUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === `${serverCoreIconScheme}:` &&
      url.hostname === serverCoreIconHost &&
      /^\/[a-f0-9]{64}$/.test(url.pathname) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function expectServerCoreTypes(value: unknown): ServerCoreType[] {
  if (!Array.isArray(value)) {
    throw new Error("server core source returned invalid types");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`server core source returned invalid type ${index}`);
    }
    const id = Reflect.get(item, "id");
    const iconUrl = Reflect.get(item, "iconUrl");
    if (typeof id !== "string" || !id || (iconUrl !== undefined && !isServerCoreIconUrl(iconUrl))) {
      throw new Error(`server core source returned invalid type ${index}`);
    }
    return { id, ...(iconUrl ? { iconUrl } : {}) };
  });
}

function expectServerCoreStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`server core source returned invalid ${label}`);
  }
  return value;
}

function expectServerCoreArtifacts(value: unknown): ServerCoreArtifact[] {
  if (!Array.isArray(value)) {
    throw new Error("server core source returned invalid artifacts");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`server core source returned invalid artifact ${index}`);
    }
    const artifact = item as Record<string, unknown>;
    const fields = ["serverType", "gameVersion", "fileName", "url", "sha256"] as const;
    if (
      artifact.source !== "cnb" ||
      fields.some((field) => typeof artifact[field] !== "string" || !artifact[field])
    ) {
      throw new Error(`server core source returned invalid artifact ${index}`);
    }
    return artifact as unknown as ServerCoreArtifact;
  });
}

function expectServerCoreDownloadTask(value: unknown): ServerCoreDownloadTaskSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server core source returned an invalid download task");
  }
  const task = value as Record<string, unknown>;
  const artifact = expectServerCoreArtifacts([task.artifact])[0]!;
  const state = task.state;
  const stringFields = ["id", "destinationPath", "createdAt"] as const;
  const numericFields = ["downloadedBytes", "totalBytes", "connections", "progress"] as const;
  if (
    stringFields.some((field) => typeof task[field] !== "string" || !task[field]) ||
    numericFields.some(
      (field) => typeof task[field] !== "number" || !Number.isFinite(task[field]),
    ) ||
    !["queued", "downloading", "completed", "failed", "cancelled"].includes(String(state)) ||
    (task.finishedAt !== undefined && typeof task.finishedAt !== "string") ||
    (task.error !== undefined && typeof task.error !== "string")
  ) {
    throw new Error("server core source returned an invalid download task");
  }
  return { ...task, artifact } as unknown as ServerCoreDownloadTaskSnapshot;
}

function expectServerCoreDownloadTasks(value: unknown): ServerCoreDownloadTaskSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("server core source returned invalid download tasks");
  }
  return value.map(expectServerCoreDownloadTask);
}

function expectManagedDownloadResult(value: unknown): ServerCoreManagedDownloadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server instance manager returned an invalid managed download");
  }
  const instanceId = Reflect.get(value, "instanceId");
  const task = Reflect.get(value, "task");
  if (typeof instanceId !== "string" || !instanceId) {
    throw new Error("server instance manager returned an invalid managed download");
  }
  return {
    instanceId,
    task: expectServerCoreDownloadTask(task),
  };
}

function expectServerInstances(value: unknown): ServerInstanceSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("server instance manager returned invalid instances");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`server instance manager returned invalid instance ${index}`);
    }
    const instance = item as Record<string, unknown>;
    const requiredStrings = [
      "id",
      "name",
      "rootPath",
      "coreJarPath",
      "createdAt",
      "updatedAt",
    ] as const;
    const optionalStrings = [
      "iconPath",
      "serverType",
      "gameVersion",
      "coreArtifactFileName",
      "artifactSha256",
      "lastStartedAt",
    ] as const;
    if (
      requiredStrings.some((field) => typeof instance[field] !== "string" || !instance[field]) ||
      optionalStrings.some(
        (field) => instance[field] !== undefined && typeof instance[field] !== "string",
      ) ||
      !["managed", "external"].includes(String(instance.storageMode)) ||
      !["downloaded", "imported"].includes(String(instance.source))
    ) {
      throw new Error(`server instance manager returned invalid instance ${index}`);
    }
    const snapshot = instance as unknown as ServerInstanceSnapshot;
    return {
      ...snapshot,
      ...(snapshot.iconPath
        ? {
            iconUrl: `${serverCoreIconScheme}://${serverInstanceIconHost}/${encodeURIComponent(snapshot.id)}`,
          }
        : {}),
    };
  });
}

const serverConfigurationKinds = new Set(["properties", "yaml", "json", "toml", "text"]);

function expectServerConfigurationFile(value: unknown, label: string): ServerConfigurationFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`server configuration returned invalid ${label}`);
  }
  const file = value as Record<string, unknown>;
  if (
    typeof file.path !== "string" ||
    !file.path ||
    file.path.startsWith("/") ||
    file.path.includes("\\") ||
    file.path.split("/").some((part) => !part || part === "." || part === "..") ||
    typeof file.name !== "string" ||
    !file.name ||
    !serverConfigurationKinds.has(String(file.kind)) ||
    !["server", "plugin"].includes(String(file.scope)) ||
    (file.pluginName !== undefined && (typeof file.pluginName !== "string" || !file.pluginName))
  ) {
    throw new Error(`server configuration returned invalid ${label}`);
  }
  return file as unknown as ServerConfigurationFile;
}

function expectServerConfigurationCatalog(value: unknown): ServerConfigurationCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server configuration returned an invalid catalog");
  }
  const catalog = value as Record<string, unknown>;
  if (
    typeof catalog.instanceId !== "string" ||
    !catalog.instanceId ||
    (catalog.serverType !== undefined && typeof catalog.serverType !== "string") ||
    typeof catalog.pluginSupported !== "boolean" ||
    !Array.isArray(catalog.serverFiles) ||
    !Array.isArray(catalog.plugins)
  ) {
    throw new Error("server configuration returned an invalid catalog");
  }
  const serverFiles = catalog.serverFiles.map((file, index) =>
    expectServerConfigurationFile(file, `server file ${index}`),
  );
  const plugins = catalog.plugins.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`server configuration returned invalid plugin ${index}`);
    }
    const plugin = value as Record<string, unknown>;
    if (typeof plugin.name !== "string" || !plugin.name || !Array.isArray(plugin.files)) {
      throw new Error(`server configuration returned invalid plugin ${index}`);
    }
    return {
      name: plugin.name,
      files: plugin.files.map((file, fileIndex) =>
        expectServerConfigurationFile(file, `plugin ${index} file ${fileIndex}`),
      ),
    };
  });
  return {
    instanceId: catalog.instanceId,
    ...(catalog.serverType ? { serverType: catalog.serverType as string } : {}),
    pluginSupported: catalog.pluginSupported,
    serverFiles,
    plugins,
  };
}

function expectServerConfigurationDocument(value: unknown): ServerConfigurationDocument {
  const file = expectServerConfigurationFile(value, "document");
  const document = value as unknown as Record<string, unknown>;
  if (
    typeof document.instanceId !== "string" ||
    !document.instanceId ||
    typeof document.content !== "string" ||
    typeof document.revision !== "string" ||
    !/^[a-f0-9]{64}$/u.test(document.revision) ||
    !["utf-8", "utf-8-bom"].includes(String(document.encoding)) ||
    typeof document.modifiedAt !== "string" ||
    !document.modifiedAt
  ) {
    throw new Error("server configuration returned an invalid document");
  }
  return { ...file, ...document } as ServerConfigurationDocument;
}

const javaInstallationSources = new Set<JavaInstallationSource>([
  "java-home",
  "path",
  "registry",
  "filesystem",
  "manual",
]);

/** 收窄 Host 组件返回值，禁止未经验证的文件系统路径进入 Renderer。 */
function expectJavaInstallation(value: unknown, label = "installation"): JavaInstallationSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`java runtime manager returned invalid ${label}`);
  }
  const installation = value as Record<string, unknown>;
  const requiredStrings = ["id", "path", "javaHome", "version", "vendor", "architecture"] as const;
  if (
    requiredStrings.some(
      (field) => typeof installation[field] !== "string" || !installation[field],
    ) ||
    !isAbsolute(installation.path as string) ||
    !isAbsolute(installation.javaHome as string) ||
    !Number.isSafeInteger(installation.majorVersion) ||
    (installation.majorVersion as number) <= 0 ||
    typeof installation.is64Bit !== "boolean" ||
    !javaInstallationSources.has(installation.source as JavaInstallationSource)
  ) {
    throw new Error(`java runtime manager returned invalid ${label}`);
  }
  return installation as unknown as JavaInstallationSnapshot;
}

function expectJavaInstallations(value: unknown): JavaInstallationSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("java runtime manager returned invalid installations");
  }
  return value.map((item, index) => expectJavaInstallation(item, `installation ${index}`));
}

function expectServerSettingsSnapshot(value: unknown): ServerSettingsSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server settings returned an invalid snapshot");
  }
  const resourceDownloadDirectory = Reflect.get(value, "resourceDownloadDirectory");
  const defaultDownloadConnections = Reflect.get(value, "defaultDownloadConnections");
  const defaultMinimumMemoryMiB = Reflect.get(value, "defaultMinimumMemoryMiB");
  const defaultMaximumMemoryMiB = Reflect.get(value, "defaultMaximumMemoryMiB");
  const defaultServerPort = Reflect.get(value, "defaultServerPort");
  const autoAcceptEula = Reflect.get(value, "autoAcceptEula");
  const defaultJvmArguments = Reflect.get(value, "defaultJvmArguments");
  if (
    typeof resourceDownloadDirectory !== "string" ||
    !Number.isSafeInteger(defaultDownloadConnections) ||
    (defaultDownloadConnections as number) < serverDownloadConnectionLimits.minimum ||
    (defaultDownloadConnections as number) > serverDownloadConnectionLimits.maximum ||
    !Number.isSafeInteger(defaultMinimumMemoryMiB) ||
    (defaultMinimumMemoryMiB as number) <= 0 ||
    !Number.isSafeInteger(defaultMaximumMemoryMiB) ||
    (defaultMaximumMemoryMiB as number) < (defaultMinimumMemoryMiB as number) ||
    !Number.isSafeInteger(defaultServerPort) ||
    (defaultServerPort as number) < serverPortLimits.minimum ||
    (defaultServerPort as number) > serverPortLimits.maximum ||
    typeof autoAcceptEula !== "boolean" ||
    typeof defaultJvmArguments !== "string" ||
    defaultJvmArguments.length > serverJvmArgumentsMaximumLength ||
    defaultJvmArguments.includes("\0")
  ) {
    throw new Error("server settings returned an invalid snapshot");
  }
  return {
    resourceDownloadDirectory,
    defaultDownloadConnections: defaultDownloadConnections as number,
    defaultMinimumMemoryMiB: defaultMinimumMemoryMiB as number,
    defaultMaximumMemoryMiB: defaultMaximumMemoryMiB as number,
    defaultServerPort: defaultServerPort as number,
    autoAcceptEula,
    defaultJvmArguments,
  };
}

function expectServerRuntimeSnapshot(value: unknown): ServerRuntimeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server runtime returned an invalid snapshot");
  }
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.instanceId !== "string" ||
    !snapshot.instanceId ||
    !["stopped", "starting", "running", "stopping", "failed"].includes(String(snapshot.state)) ||
    (snapshot.pid !== undefined &&
      (!Number.isSafeInteger(snapshot.pid) || (snapshot.pid as number) <= 0)) ||
    (snapshot.startedAt !== undefined && typeof snapshot.startedAt !== "string") ||
    (snapshot.stoppedAt !== undefined && typeof snapshot.stoppedAt !== "string") ||
    (snapshot.exitCode !== undefined && !Number.isSafeInteger(snapshot.exitCode)) ||
    (snapshot.error !== undefined && typeof snapshot.error !== "string")
  ) {
    throw new Error("server runtime returned an invalid snapshot");
  }
  return snapshot as unknown as ServerRuntimeSnapshot;
}

function expectServerConsoleLine(value: unknown): ServerConsoleLine {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server runtime returned an invalid console line");
  }
  const line = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(line.sequence) ||
    (line.sequence as number) <= 0 ||
    typeof line.instanceId !== "string" ||
    !line.instanceId ||
    !["stdout", "stderr", "input", "system"].includes(String(line.stream)) ||
    typeof line.text !== "string" ||
    typeof line.timestamp !== "string" ||
    !line.timestamp
  ) {
    throw new Error("server runtime returned an invalid console line");
  }
  return line as unknown as ServerConsoleLine;
}

function expectServerConsoleLines(value: unknown): ServerConsoleLine[] {
  if (!Array.isArray(value)) {
    throw new Error("server runtime returned invalid console lines");
  }
  return value.map(expectServerConsoleLine);
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
  // “关于”作为可独立启停的内置 Client UI 功能，进入统一设置导航。
  await activeKernel.registerBuiltIn({
    manifest: aboutUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.about.ui",
        entryId: "about.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 个性化作为可独立启停的内置 Client UI 功能，进入统一设置导航。
  await activeKernel.registerBuiltIn({
    manifest: personalizationUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.personalization.ui",
        entryId: "personalization.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 游戏运行环境设置只消费 Java Host 组件发布的扫描 Contract。
  await activeKernel.registerBuiltIn({
    manifest: gameSettingsUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.game-settings.ui",
        entryId: "game-settings.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 服务器下载页是独立 Client Entry；真实核心目录通过收窄的只读 Client Service 提供。
  await activeKernel.registerBuiltIn({
    manifest: serverDownloadUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-download.ui",
        entryId: "server-download.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 服务器启动页读取实例管理器的持久化投影；进程启停状态仍由后续运行组件接管。
  await activeKernel.registerBuiltIn({
    manifest: serverLaunchUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-launch.ui",
        entryId: "server-launch.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 服务器下载设置 UI 只消费收窄的 Client Service；目录由独立 Host 设置组件持久化。
  await activeKernel.registerBuiltIn({
    manifest: serverSettingsUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-settings.ui",
        entryId: "server-settings.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 诊断页面独立于 Host 投影组件发布，前端目录不再混入 Core 能力包。
  await activeKernel.registerBuiltIn({
    manifest: runtimeDiagnosticsUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.runtime-diagnostics.ui",
        entryId: "runtime-diagnostics.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 公共下载组件集中管理所有文件任务；业务组件通过 Service 注入复用，不各自实现传输层。
  await activeKernel.registerBuiltIn({
    manifest: downloadManifest,
    loaders: {
      "download.host": {
        load: async () =>
          createDownloadModule({
            fetchProvider: downloadFetchProvider,
            defaultHeaders: { "User-Agent": `SeaShard/${seaShardVersion}` },
            defaultConnections: serverDownloadConnectionLimits.defaultValue,
            maxConnections: serverDownloadConnectionLimits.maximum,
          }),
      },
    },
    bindings: [
      {
        id: "core.download",
        entryId: "download.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 服务器设置使用 Runtime 独占的 SQLite 文档存储，默认资源目录位于应用数据目录。
  await activeKernel.registerBuiltIn({
    manifest: serverSettingsManifest,
    loaders: {
      "server-settings.host": {
        load: async () =>
          createServerSettingsModule({
            defaultResourceDownloadDirectory: join(dataRoot, "resources"),
            defaultDownloadConnections: serverDownloadConnectionLimits.defaultValue,
          }),
      },
    },
    bindings: [
      {
        id: "core.server-settings",
        entryId: "server-settings.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 服务端核心源作为独立后端能力，当前提供 CNB 目录、持久缓存与受校验的下载任务。
  await activeKernel.registerBuiltIn({
    manifest: serverCoreSourceManifest,
    loaders: {
      "server-core-source.host": {
        load: async () =>
          createServerCoreSourceModule({
            database: root.database,
            fetchProvider: downloadFetchProvider,
            iconCacheDirectory: join(dataRoot, "cache", "server-core-icons"),
          }),
      },
    },
    bindings: [
      {
        id: "core.server-core-source",
        entryId: "server-core-source.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 实例管理器只登记校验成功的托管下载，并在独立目录写入可移植描述文件。
  await activeKernel.registerBuiltIn({
    manifest: serverInstanceManagerManifest,
    loaders: {
      "server-instance-manager.host": {
        load: async () =>
          createServerInstanceManagerModule({
            database: root.database,
            managedRoot: join(dataRoot, "servers"),
            reportError: (error) =>
              console.error("Managed server instance finalization failed", error),
          }),
      },
    },
    bindings: [
      {
        id: "core.server-instance-manager",
        entryId: "server-instance-manager.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 配置管理器在实例边界内列出并修改 UTF-8 配置文件，写入时校验 revision 并先备份。
  await activeKernel.registerBuiltIn({
    manifest: serverConfigurationManifest,
    loaders: {
      "server-configuration.host": {
        load: async () => createServerConfigurationModule(),
      },
    },
    bindings: [
      {
        id: "core.server-configuration",
        entryId: "server-configuration.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // Java 自动发现只读取 release 等安装元数据，不执行文件系统中发现的未知程序。
  await activeKernel.registerBuiltIn({
    manifest: javaRuntimeManagerManifest,
    loaders: {
      "java-runtime-manager.host": {
        load: async () =>
          createJavaRuntimeManagerModule({
            reportError: (error) => console.warn("Java runtime candidate ignored", error),
          }),
      },
    },
    bindings: [
      {
        id: "core.java-runtime-manager",
        entryId: "java-runtime-manager.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 服务器运行组件只接受实例元数据显式声明的 vanilla 类型；启动阶段不探测核心文件。
  await activeKernel.registerBuiltIn({
    manifest: serverRuntimeManifest,
    loaders: {
      "server-runtime.host": {
        load: async () =>
          createServerRuntimeModule({
            onConsoleLine: publishServerConsoleLine,
            reportError: (error) => console.error("Server runtime failed", error),
          }),
      },
    },
    bindings: [
      {
        id: "core.server-runtime",
        entryId: "server-runtime.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
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
  // BrowserWindow、Sender 授权和 IPC Handler 属于同一个 Desktop Shell 生命周期。
  await activeKernel.registerBuiltIn({
    manifest: desktopShellManifest,
    loaders: {
      "desktop-shell.host": {
        load: async () =>
          createDesktopShellModule({
            runtime: createElectronDesktopShellRuntime(
              app,
              BrowserWindow,
              ipcMain,
              dialog,
              protocol,
              net,
            ),
            preloadPath: join(moduleDirectory, "../preload/index.cjs"),
            rendererFile: join(moduleDirectory, "../renderer/index.html"),
            ...(developmentUrl ? { developmentUrl } : {}),
            smokeMode,
            reportOpenFailure: (error) => console.error("Desktop window open failed", error),
            readClientEntryPublication: () =>
              projectClientEntryPublication(activeKernel.clientEntrySnapshot()),
            onClientEntriesChanged: (listener) =>
              activeKernel.onClientEntriesChanged((snapshot) =>
                listener(projectClientEntryPublication(snapshot)),
              ),
            readServerCoreTypes: async () =>
              expectServerCoreTypes(
                await activeKernel.callService(serverCoreSourceContract, "listTypes", []),
              ),
            readServerCoreVersions: async (serverType) =>
              expectServerCoreStrings(
                await activeKernel.callService(serverCoreSourceContract, "listVersions", [
                  serverType,
                ]),
                "versions",
              ),
            readServerCoreArtifacts: async (serverType, gameVersion) =>
              expectServerCoreArtifacts(
                await activeKernel.callService(serverCoreSourceContract, "listArtifacts", [
                  serverType,
                  gameVersion,
                ]),
              ),
            resolveServerCoreIconPath: async (sha256) => {
              const path = await activeKernel.callService(
                serverCoreSourceContract,
                "resolveIconPath",
                [sha256],
              );
              if (path === null) return undefined;
              if (typeof path !== "string" || !isAbsolute(path)) {
                throw new Error("server core source returned an invalid icon cache path");
              }
              return path;
            },
            resolveServerInstanceIconPath: async (instanceId) => {
              const path = await activeKernel.callService(
                serverInstanceManagerContract,
                "resolveIconPath",
                [instanceId],
              );
              if (path === null) return undefined;
              if (typeof path !== "string" || !isAbsolute(path)) {
                throw new Error("server instance manager returned an invalid icon path");
              }
              return path;
            },
            readServerSettings: async () =>
              expectServerSettingsSnapshot(
                await activeKernel.callService(serverSettingsContract, "get", []),
              ),
            writeResourceDownloadDirectory: async (directory) =>
              expectServerSettingsSnapshot(
                await activeKernel.callService(
                  serverSettingsContract,
                  "setResourceDownloadDirectory",
                  [directory],
                ),
              ),
            writeDefaultDownloadConnections: async (connections) =>
              expectServerSettingsSnapshot(
                await activeKernel.callService(
                  serverSettingsContract,
                  "setDefaultDownloadConnections",
                  [connections],
                ),
              ),
            writeServerStartupDefaults: async (update: ServerStartupDefaultsUpdate) =>
              expectServerSettingsSnapshot(
                await activeKernel.callService(serverSettingsContract, "setStartupDefaults", [
                  update as unknown as JsonValue,
                ]),
              ),
            startServerCoreDownload: async (request) =>
              expectServerCoreDownloadTask(
                await activeKernel.callService(serverCoreSourceContract, "start", [
                  request as unknown as JsonValue,
                ]),
              ),
            startManagedServerCoreDownload: async (request) =>
              expectManagedDownloadResult(
                await activeKernel.callService(serverInstanceManagerContract, "createManaged", [
                  request as unknown as JsonValue,
                ]),
              ),
            listServerInstances: async () =>
              expectServerInstances(
                await activeKernel.callService(serverInstanceManagerContract, "list", []),
              ),
            deleteServerInstance: async (instanceId) => {
              const result = await activeKernel.callService(
                serverInstanceManagerContract,
                "delete",
                [instanceId],
              );
              if (result !== null) {
                throw new Error("server instance manager returned an invalid delete result");
              }
            },
            listServerConfigurations: async (instanceId) =>
              expectServerConfigurationCatalog(
                await activeKernel.callService(serverConfigurationContract, "list", [instanceId]),
              ),
            readServerConfiguration: async (instanceId, path) =>
              expectServerConfigurationDocument(
                await activeKernel.callService(serverConfigurationContract, "read", [
                  instanceId,
                  path,
                ]),
              ),
            writeServerConfiguration: async (request: ServerConfigurationWriteRequest) =>
              expectServerConfigurationDocument(
                await activeKernel.callService(serverConfigurationContract, "write", [
                  request as unknown as JsonValue,
                ]),
              ),
            readServerRuntime: async (instanceId) =>
              expectServerRuntimeSnapshot(
                await activeKernel.callService(serverRuntimeContract, "get", [instanceId]),
              ),
            startServerRuntime: async (instanceId) =>
              expectServerRuntimeSnapshot(
                await activeKernel.callService(serverRuntimeContract, "start", [instanceId]),
              ),
            stopServerRuntime: async (instanceId) =>
              expectServerRuntimeSnapshot(
                await activeKernel.callService(serverRuntimeContract, "stop", [instanceId]),
              ),
            sendServerCommand: async (instanceId, command) => {
              const result = await activeKernel.callService(serverRuntimeContract, "sendCommand", [
                instanceId,
                command,
              ]);
              if (result !== null) {
                throw new Error("server runtime returned an invalid command result");
              }
            },
            readServerConsoleLines: async (instanceId, afterSequence) =>
              expectServerConsoleLines(
                await activeKernel.callService(serverRuntimeContract, "getLogs", [
                  instanceId,
                  afterSequence,
                ]),
              ),
            onServerConsoleLine,
            scanJavaInstallations: async () =>
              expectJavaInstallations(
                await activeKernel.callService(javaRuntimeManagerContract, "scan", []),
              ),
            inspectJavaInstallation: async (executablePath) =>
              expectJavaInstallation(
                await activeKernel.callService(javaRuntimeManagerContract, "inspect", [
                  executablePath,
                ]),
              ),
            listServerCoreDownloadTasks: async () =>
              expectServerCoreDownloadTasks(
                await activeKernel.callService(serverCoreSourceContract, "listTasks", []),
              ),
            cancelServerCoreDownload: async (taskId) => {
              const cancelled = await activeKernel.callService(serverCoreSourceContract, "cancel", [
                taskId,
              ]);
              if (typeof cancelled !== "boolean") {
                throw new Error("server core source returned an invalid cancellation result");
              }
              return cancelled;
            },
            onRendererReady: (snapshot) => {
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
        id: "core.desktop-shell",
        entryId: "desktop-shell.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  await registerSmokePlugin(kernel);
  await kernel.start();
  if (smokeMode) {
    const instances = expectServerInstances(
      await kernel.callService(serverInstanceManagerContract, "list", []),
    );
    console.log(`SEASHARD_SMOKE_SERVER_INSTANCES count=${instances.length}`);
  }
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

  // 全部组件发布后再加载 Renderer，Preload 的首个调用必定命中已注册的 Shell Handler。
  await activeKernel.callService(desktopShellContract, "openPrimary", []);
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
