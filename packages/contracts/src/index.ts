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
  serverCoreDownloadSaveAs: "seashard.server-core-download.save-as",
  serverCoreDownloadListTasks: "seashard.server-core-download.list-tasks",
  serverCoreDownloadCancel: "seashard.server-core-download.cancel",
  serverCoreDownloadStartManaged: "seashard.server-core-download.start-managed",
  serverInstancesList: "seashard.server-instances.list",
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
}

/** 可持久化并跨 Host/Client 边界传输的服务器设置快照。 */
export interface ServerSettingsSnapshot {
  resourceDownloadDirectory: string;
  defaultDownloadConnections: number;
}

/** Renderer 只获得设置读写能力，不接触插件存储或数据库对象。 */
export interface ServerSettingsClientService {
  get(): Promise<ServerSettingsSnapshot>;
  setResourceDownloadDirectory(directory: string): Promise<ServerSettingsSnapshot>;
  setDefaultDownloadConnections(connections: number): Promise<ServerSettingsSnapshot>;
}

export interface SeaShardDesktopApi {
  runtime: {
    getSnapshot(): Promise<RuntimeSnapshot>;
  };
  serverCore: ServerCoreSourceClientService;
  serverSettings: ServerSettingsClientService;
  serverCoreDownload: ServerCoreDownloadClientService;
  serverInstances: ServerInstanceClientService;
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
