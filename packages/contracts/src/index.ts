import type { ActivationScope, JsonValue } from "@seashard/plugin-sdk";

export type RuntimePhase = "active" | "updating" | "blocked" | "failed";

export const desktopChannels = {
  runtimeSnapshot: "seashard.runtime.snapshot",
  clientBootstrap: "seashard.client.bootstrap",
  clientBootstrapChanged: "seashard.client.bootstrap-changed",
  rendererReady: "seashard.client.renderer-ready",
  windowMinimize: "seashard.window.minimize",
  windowToggleMaximize: "seashard.window.toggle-maximize",
  windowClose: "seashard.window.close",
  serverCoreTypes: "seashard.server-core.types",
  serverCoreVersions: "seashard.server-core.versions",
  serverCoreArtifacts: "seashard.server-core.artifacts",
  dialogSelectDirectory: "seashard.dialog.select-directory",
  serverSettingsGet: "seashard.server-settings.get",
  serverSettingsSetResourceDownloadDirectory:
    "seashard.server-settings.set-resource-download-directory",
  serverSettingsSetDefaultDownloadConnections:
    "seashard.server-settings.set-default-download-connections",
  serverSettingsSetStartupDefaults: "seashard.server-settings.set-startup-defaults",
  serverCoreDownloadSaveAs: "seashard.server-core-download.save-as",
  serverCoreDownloadListTasks: "seashard.server-core-download.list-tasks",
  serverCoreDownloadCancel: "seashard.server-core-download.cancel",
  serverCoreDownloadStartManaged: "seashard.server-core-download.start-managed",
  serverInstancesList: "seashard.server-instances.list",
  serverInstancesDelete: "seashard.server-instances.delete",
  javaRuntimeScan: "seashard.java-runtime.scan",
  serverRuntimeGet: "seashard.server-runtime.get",
  serverRuntimeStart: "seashard.server-runtime.start",
  serverRuntimeStop: "seashard.server-runtime.stop",
  serverRuntimeSendCommand: "seashard.server-runtime.send-command",
  serverRuntimeGetLogs: "seashard.server-runtime.get-logs",
  serverRuntimeConsoleLine: "seashard.server-runtime.console-line",
  serverConfigurationList: "seashard.server-configuration.list",
  serverConfigurationRead: "seashard.server-configuration.read",
  serverConfigurationWrite: "seashard.server-configuration.write",
  javaRuntimeAdd: "seashard.java-runtime.add",
  javaRuntimeRemove: "seashard.java-runtime.remove",
  javaRuntimeSetDisabled: "seashard.java-runtime.set-disabled",
} as const;

/** 内建运行诊断组件发布的类型化 Service contract。 */
export const runtimeDiagnosticsContract = "seashard.runtime-diagnostics";
/** 服务端核心源面向 Client 的只读 Contract。 */
export const serverCoreSourceContract = "seashard.server-core-source";
/** Renderer 通过受限本地协议读取已经校验并落盘的核心图标。 */
export const serverCoreIconScheme = "seashard-cache";
export const serverCoreIconHost = "server-core-icon";
/** Renderer 通过受限本地协议读取已复制到实例目录的服务器图标。 */
export const serverInstanceIconHost = "server-instance-icon";
/** 服务器设置 Host 组件发布的稳定 Service contract。 */
export const serverSettingsContract = "seashard.server-settings";
/** 当前 Client 平台提供的服务器核心下载交互；Desktop 使用系统目录选择窗口。 */
export const serverCoreDownloadContract = "seashard.server-core-download";
/** 服务器实例管理组件发布的持久化实例 Service contract。 */
export const serverInstanceManagerContract = "seashard.server-instance-manager";
/** 服务器进程运行组件发布的 Host/Client 稳定 Contract。 */
export const serverRuntimeContract = "seashard.server-runtime";
/** 服务器与插件配置文件管理组件发布的 Host/Client 稳定 Contract。 */
export const serverConfigurationContract = "seashard.server-configuration";
/** Java 运行环境管理组件发布的只读扫描 Service contract。 */
export const javaRuntimeManagerContract = "seashard.java-runtime-manager";

/** Desktop Shell 发布的主窗口生命周期 Service contract。 */
export const desktopShellContract = "seashard.desktop-shell";

/** 面向客户端的单个 runtime 投影视图。 */
export type ComponentSnapshot = {
  id: string;
  displayName: string;
  generation: number;
  phase: RuntimePhase;
  error?: string;
};

/** 可跨插件 Service 与 IPC 传输的稳定运行态读取模型。 */
export type RuntimeSnapshot = {
  protocolVersion: 1;
  host: "electron";
  state: "active" | "degraded" | "stopping";
  startedAt: string;
  components: ComponentSnapshot[];
};

/** Runtime Diagnostics Service 的消费者契约。 */
export interface RuntimeDiagnosticsService {
  getSnapshot(): Promise<RuntimeSnapshot>;
}

/** Desktop Shell Service 的宿主消费者契约。 */
export interface DesktopShellService {
  openPrimary(): Promise<void>;
}
export type ClientSurface = "primary";

/** Main 允许当前 Renderer 激活的单个 Client Entry；不暴露包目录或宿主内部对象。 */
export interface ClientEntryDescriptor {
  runtimeId: string;
  pluginId: string;
  pluginVersion: string;
  entryId: string;
  moduleKey: string;
  integrity: string;
  scopeType: ActivationScope;
  scopeId: string;
  config: JsonValue;
}

/** Client Entry 期望状态；revision 用于丢弃迟到的 Renderer 更新。 */
export interface ClientEntryPublication {
  revision: number;
  entries: readonly ClientEntryDescriptor[];
}

/** 每个 Electron WebContents 独立取得的桌面 Client 启动快照。 */
export interface DesktopClientBootstrap extends ClientEntryPublication {
  protocolVersion: 1;
  clientSession: {
    id: string;
    target: "desktop";
    surface: ClientSurface;
  };
}

/** Renderer 可安全读取的服务端核心类型；图标地址只指向 Host 本地缓存协议。 */
export interface ServerCoreType {
  id: string;
  iconUrl?: string;
}
const serverCoreTypeNames: Readonly<Record<string, string>> = {
  "arclight-fabric": "Arclight Fabric",
  "arclight-forge": "Arclight Forge",
  "arclight-neoforge": "Arclight NeoForge",
  banner: "Banner",
  bukkit: "Bukkit",
  bungeecord: "BungeeCord",
  catserver: "CatServer",
  fabric: "Fabric",
  folia: "Folia",
  leaf: "Leaf",
  leaves: "Leaves",
  lightfall: "Lightfall",
  mohist: "Mohist",
  neoforge: "NeoForge",
  nukkitx: "NukkitX",
  paper: "Paper",
  pufferfish: "Pufferfish",
  pufferfish_purpur: "Pufferfish Purpur",
  purpur: "Purpur",
  quilt: "Quilt",
  spigot: "Spigot",
  spongeforge: "SpongeForge",
  spongevanilla: "SpongeVanilla",
  travertine: "Travertine",
  vanilla: "原版核心",
  "vanilla-snapshot": "原版快照",
  velocity: "Velocity",
  youer: "Youer",
};

/** 核心目录、实例页和运行页共享同一显示名称，未知类型再按标识符安全回退。 */
export function formatServerCoreType(type: string): string {
  return (
    serverCoreTypeNames[type] ??
    type
      .split(/[-_]/u)
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" ")
  );
}

/** Renderer 可安全读取的服务端核心产物；下载地址只由宿主目录服务提供。 */
export interface ServerCoreArtifact {
  source: "cnb";
  serverType: string;
  gameVersion: string;
  fileName: string;
  url: string;
  sha256: string;
}

/** Renderer 只读的服务端核心目录能力，不暴露下载路径或宿主对象。 */
export interface ServerCoreSourceClientService {
  listTypes(): Promise<readonly ServerCoreType[]>;
  listVersions(serverType: string): Promise<readonly string[]>;
  listArtifacts(serverType: string, gameVersion: string): Promise<readonly ServerCoreArtifact[]>;
}
/** 默认下载并发数的稳定边界；服务端设置和公共下载器必须保持一致。 */
export const serverDownloadConnectionLimits = {
  minimum: 1,
  maximum: 32,
  defaultValue: 8,
} as const;

/** 新服务器继承的全局启动默认值；具体实例后续可以单独覆盖。 */
export const serverStartupDefaults = {
  minimumMemoryMiB: 512,
  maximumMemoryMiB: 2_048,
  port: 25_565,
  autoAcceptEula: true,
  jvmArguments: "",
} as const;

export const serverPortLimits = {
  minimum: 1,
  maximum: 65_535,
} as const;

/** 防止无界 IPC 与持久化输入；该值只限制参数文本，不改变 JVM 参数语义。 */
export const serverJvmArgumentsMaximumLength = 8_192;

export type ServerCoreDownloadTaskState =
  | "queued"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled";

/** “另存为”只提交目录服务可验证的产物身份，不允许 Renderer 传入任意 URL。 */
export interface ServerCoreSaveAsRequest {
  serverType: string;
  gameVersion: string;
  artifactFileName: string;
  destinationFileName: string;
}
/** “开始下载”创建由 SeaShard 托管的实例；目标目录只能由 Host 决定。 */
export interface ServerCoreManagedDownloadRequest extends ServerCoreSaveAsRequest {}

/** 托管下载立即返回任务与预留实例 ID，下载完成后可精确跳转到新实例。 */
export interface ServerCoreManagedDownloadResult {
  instanceId: string;
  task: ServerCoreDownloadTaskSnapshot;
}

/** 顶栏和下载页共享的服务器核心任务投影。 */
export interface ServerCoreDownloadTaskSnapshot {
  id: string;
  artifact: ServerCoreArtifact;
  destinationPath: string;
  state: ServerCoreDownloadTaskState;
  downloadedBytes: number;
  totalBytes: number;
  connections: number;
  progress: number;
  createdAt: string;
  finishedAt?: string;
  error?: string;
}

/** 当前 Client 平台实现托管下载、另存为、进度读取和取消。 */
export interface ServerCoreDownloadClientService {
  startManaged(request: ServerCoreManagedDownloadRequest): Promise<ServerCoreManagedDownloadResult>;
  saveAs(request: ServerCoreSaveAsRequest): Promise<ServerCoreDownloadTaskSnapshot | undefined>;
  listTasks(): Promise<readonly ServerCoreDownloadTaskSnapshot[]>;
  cancel(taskId: string): Promise<boolean>;
}

export type ServerInstanceStorageMode = "managed" | "external";
export type ServerInstanceSource = "downloaded" | "imported";

/** 服务器事实与 SeaShard 私有 JSON 合并后的稳定 Client 投影。 */
export interface ServerInstanceSnapshot {
  id: string;
  name: string;
  rootPath: string;
  coreJarPath: string;
  iconPath?: string;
  storageMode: ServerInstanceStorageMode;
  source: ServerInstanceSource;
  serverType?: string;
  gameVersion?: string;
  coreArtifactFileName?: string;
  artifactSha256?: string;
  createdAt: string;
  updatedAt: string;
  iconUrl?: string;
  lastStartedAt?: string;
}

/** Renderer 只读取已经完成注册的实例，不接触 JSON 文件、SQLite 或临时下载状态。 */
export interface ServerInstanceClientService {
  list(): Promise<readonly ServerInstanceSnapshot[]>;
  /** 删除 Host 已登记的托管实例目录及其数据库路径记录。 */
  delete(instanceId: string): Promise<void>;
}

/** 运行组件已实现并可由启动页直接调度的核心类型。 */
export const serverRuntimeSupportedTypes = [
  "vanilla",
  "paper",
  "purpur",
  "folia",
  "fabric",
  "quilt",
  "neoforge",
  "arclight-neoforge",
  "mohist",
  "velocity",
  "nukkitx",
  "arclight-fabric",
  "arclight-forge",
  "banner",
  "bukkit",
  "bungeecord",
  "catserver",
  "leaf",
  "leaves",
  "lightfall",
  "pufferfish",
  "pufferfish_purpur",
  "spigot",
  "spongeforge",
  "spongevanilla",
  "travertine",
  "vanilla-snapshot",
  "youer",
] as const;
export type ServerRuntimeSupportedType = (typeof serverRuntimeSupportedTypes)[number];

/** Renderer 与 Host 共享同一支持列表，避免页面和进程管理器各维护一份条件链。 */
export function isServerRuntimeSupportedType(value: unknown): value is ServerRuntimeSupportedType {
  return (
    typeof value === "string" && (serverRuntimeSupportedTypes as readonly string[]).includes(value)
  );
}

export type ServerProcessState = "stopped" | "starting" | "running" | "stopping" | "failed";
export type ServerConsoleStream = "stdout" | "stderr" | "input" | "system";

/** 单个服务器进程的可序列化状态；不暴露 ChildProcess 或宿主句柄。 */
export interface ServerRuntimeSnapshot {
  instanceId: string;
  state: ServerProcessState;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number;
  error?: string;
}

/** 进程输出按实例递增编号，Renderer 可用编号补拉事件订阅前后的缺口。 */
export interface ServerConsoleLine {
  sequence: number;
  instanceId: string;
  stream: ServerConsoleStream;
  text: string;
  timestamp: string;
}

/** Host 侧服务器进程能力；仅启动实例元数据中明确声明且已实现运行策略的核心。 */
export interface ServerRuntimeService {
  get(instanceId: string): Promise<ServerRuntimeSnapshot>;
  start(instanceId: string): Promise<ServerRuntimeSnapshot>;
  stop(instanceId: string): Promise<ServerRuntimeSnapshot>;
  sendCommand(instanceId: string, command: string): Promise<void>;
  getLogs(instanceId: string, afterSequence?: number): Promise<readonly ServerConsoleLine[]>;
}

/** Desktop Client 在请求式进程能力之外获得实时控制台事件。 */
export interface ServerRuntimeClientService extends ServerRuntimeService {
  onConsoleLine(listener: (line: ServerConsoleLine) => void): () => void;
}

export type ServerConfigurationFileKind = "properties" | "yaml" | "json" | "toml" | "text";
export type ServerConfigurationFileScope = "server" | "other" | "plugin";
export type ServerConfigurationTextEncoding = "utf-8" | "utf-8-bom";

/** Renderer 可选择的配置文件只使用实例内相对路径，不暴露宿主绝对路径。 */
export interface ServerConfigurationFile {
  path: string;
  name: string;
  kind: ServerConfigurationFileKind;
  scope: ServerConfigurationFileScope;
  pluginName?: string;
}

export interface ServerPluginConfigurationGroup {
  name: string;
  files: readonly ServerConfigurationFile[];
}

/** 单个实例当前可编辑配置的目录；其他配置只在实际发现文件时显示。 */
export interface ServerConfigurationCatalog {
  instanceId: string;
  serverType?: string;
  /** 实际配置根目录；Quilt 等核心可能位于实例根目录的子目录。 */
  configurationRootPath: string;
  pluginSupported: boolean;
  serverFiles: readonly ServerConfigurationFile[];
  otherFiles: readonly ServerConfigurationFile[];
  plugins: readonly ServerPluginConfigurationGroup[];
}

/** revision 是原始文件字节的 SHA-256，用于拒绝覆盖服务器或外部编辑器的新修改。 */
export interface ServerConfigurationDocument extends ServerConfigurationFile {
  instanceId: string;
  content: string;
  revision: string;
  encoding: ServerConfigurationTextEncoding;
  modifiedAt: string;
}

export interface ServerConfigurationWriteRequest {
  instanceId: string;
  path: string;
  content: string;
  expectedRevision: string;
}

/** 配置文件路径必须先由 list 发布；Host 仍会独立校验实例边界、后缀与符号链接。 */
export interface ServerConfigurationService {
  list(instanceId: string): Promise<ServerConfigurationCatalog>;
  read(instanceId: string, path: string): Promise<ServerConfigurationDocument>;
  write(request: ServerConfigurationWriteRequest): Promise<ServerConfigurationDocument>;
}

export interface ServerConfigurationClientService extends ServerConfigurationService {}

export type JavaInstallationSource = "java-home" | "path" | "registry" | "filesystem" | "manual";

/** 自动发现的 Java 安装；路径已经由 Host 解析为规范化绝对路径。 */
export interface JavaInstallationSnapshot {
  id: string;
  path: string;
  javaHome: string;
  version: string;
  majorVersion: number;
  vendor: string;
  architecture: string;
  is64Bit: boolean;
  source: JavaInstallationSource;
  /** 禁用项继续展示，但不会参与服务器启动时的 Java 选择。 */
  disabled: boolean;
}

/** Host 组件的完整能力；显式检查只接受用户选择的可执行文件路径。 */
export interface JavaRuntimeManagerService {
  scan(): Promise<readonly JavaInstallationSnapshot[]>;
  inspect(executablePath: string): Promise<JavaInstallationSnapshot>;
  /** 仅移除 SeaShard 保存的手动路径记录，不删除或卸载本地 Java。 */
  remove(executablePath: string): Promise<boolean>;
  /** 持久化启用状态；禁用只影响 SeaShard 选择，不修改本地 Java。 */
  setDisabled(installationId: string, disabled: boolean): Promise<boolean>;
}

/** Renderer 只触发受控扫描或系统文件选择，不直接提交任意文件系统路径。 */
export interface JavaRuntimeClientService {
  scan(): Promise<readonly JavaInstallationSnapshot[]>;
  add(): Promise<JavaInstallationSnapshot | undefined>;
  /** 仅移除通过“添加”保存的记录；自动扫描到的安装不受影响。 */
  remove(executablePath: string): Promise<boolean>;
  /** 禁用项保留在列表中，可随时重新启用。 */
  setDisabled(installationId: string, disabled: boolean): Promise<boolean>;
}

/** 一次性提交相互依赖的启动默认值，避免最小内存与最大内存出现中间非法状态。 */
export interface ServerStartupDefaultsUpdate {
  defaultMinimumMemoryMiB: number;
  defaultMaximumMemoryMiB: number;
  defaultServerPort: number;
  autoAcceptEula: boolean;
  defaultJvmArguments: string;
}

/** 可持久化并跨 Host/Client 边界传输的服务器设置快照。 */
export interface ServerSettingsSnapshot extends ServerStartupDefaultsUpdate {
  resourceDownloadDirectory: string;
  defaultDownloadConnections: number;
}

/** Renderer 只获得设置读写能力，不接触插件存储或数据库对象。 */
export interface ServerSettingsClientService {
  get(): Promise<ServerSettingsSnapshot>;
  setResourceDownloadDirectory(directory: string): Promise<ServerSettingsSnapshot>;
  setDefaultDownloadConnections(connections: number): Promise<ServerSettingsSnapshot>;
  setStartupDefaults(update: ServerStartupDefaultsUpdate): Promise<ServerSettingsSnapshot>;
}

export interface SeaShardDesktopApi {
  runtime: {
    getSnapshot(): Promise<RuntimeSnapshot>;
  };
  serverCore: ServerCoreSourceClientService;
  serverSettings: ServerSettingsClientService;
  serverCoreDownload: ServerCoreDownloadClientService;
  serverInstances: ServerInstanceClientService;
  serverRuntime: ServerRuntimeClientService;
  serverConfiguration: ServerConfigurationClientService;
  javaRuntime: JavaRuntimeClientService;
  dialog: {
    selectDirectory(): Promise<string | undefined>;
  };
  client: {
    getBootstrap(): Promise<DesktopClientBootstrap>;
    onBootstrapChanged(listener: (snapshot: DesktopClientBootstrap) => void): () => void;
    ready(): Promise<void>;
  };
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
  };
}
