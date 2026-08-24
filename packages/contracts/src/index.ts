import type {
  ActivationScope,
  AgentActivityPresentationField,
  AgentActivityPresentationIcon,
  JsonObject,
  JsonValue,
} from "@seashard/plugin-sdk";

export type RuntimePhase = "active" | "failed";

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
  serverModFilters: "seashard.server-mod.filters",
  serverModSearch: "seashard.server-mod.search",
  serverModProjectDetails: "seashard.server-mod.project-details",
  serverModInstallToInstance: "seashard.server-mod.install-to-instance",
  serverModDownloadSaveAs: "seashard.server-mod-download.save-as",
  serverSettingsGet: "seashard.server-settings.get",
  serverSettingsSetResourceDownloadDirectory:
    "seashard.server-settings.set-resource-download-directory",
  serverSettingsSetDefaultDownloadConnections:
    "seashard.server-settings.set-default-download-connections",
  serverSettingsSetStartupDefaults: "seashard.server-settings.set-startup-defaults",
  serverCoreDownloadSaveAs: "seashard.server-core-download.save-as",
  serverCoreDownloadListTasks: "seashard.server-core-download.list-tasks",
  serverCoreDownloadCancel: "seashard.server-core-download.cancel",
  fileDownloadListTasks: "seashard.file-download.list-tasks",
  fileDownloadCancel: "seashard.file-download.cancel",
  serverInstancesContentCounts: "seashard.server-instances.content-counts",
  serverCoreDownloadStartManaged: "seashard.server-core-download.start-managed",
  serverInstancesList: "seashard.server-instances.list",
  serverInstancesMods: "seashard.server-instances.mods",
  serverInstancesSetModDisabled: "seashard.server-instances.set-mod-disabled",
  serverInstancesDeleteMod: "seashard.server-instances.delete-mod",
  serverInstancesWorlds: "seashard.server-instances.worlds",
  serverInstancesSwitchWorld: "seashard.server-instances.switch-world",
  serverInstancesWorldBackups: "seashard.server-instances.world-backups",
  serverInstancesWorldDatapacks: "seashard.server-instances.world-datapacks",
  serverInstancesSetWorldDatapackDisabled: "seashard.server-instances.set-world-datapack-disabled",
  serverInstancesDeleteWorldDatapack: "seashard.server-instances.delete-world-datapack",
  serverInstancesCreateWorldBackup: "seashard.server-instances.create-world-backup",
  serverInstancesRestoreWorldBackup: "seashard.server-instances.restore-world-backup",
  serverInstancesDeleteWorldBackup: "seashard.server-instances.delete-world-backup",
  serverInstancesSetStartupSettings: "seashard.server-instances.set-startup-settings",
  serverInstancesSetIcon: "seashard.server-instances.set-icon",
  serverInstancesOpenFolder: "seashard.server-instances.open-folder",
  serverInstancesDelete: "seashard.server-instances.delete",
  javaRuntimeScan: "seashard.java-runtime.scan",
  serverRuntimeGet: "seashard.server-runtime.get",
  serverRuntimePreview: "seashard.server-runtime.preview",
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
  agentModelsList: "seashard.agent.models-list",
  agentSessionsList: "seashard.agent.sessions-list",
  agentSessionGet: "seashard.agent.session-get",
  agentSessionCopy: "seashard.agent.session-copy",
  agentSessionDelete: "seashard.agent.session-delete",
  agentSessionStart: "seashard.agent.session-start",
  agentMessageSend: "seashard.agent.message-send",
  agentInvocationGet: "seashard.agent.invocation-get",
  agentInvocationCancel: "seashard.agent.invocation-cancel",
  agentModelConfigurationGet: "seashard.agent.model-configuration.get",
  agentModelConnectionMutate: "seashard.agent.model-connection.mutate",
  agentModelConnectionRemove: "seashard.agent.model-connection.remove",
  agentModelConfigurationReset: "seashard.agent.model-configuration.reset",
  agentModelDiscover: "seashard.agent.model-discover",
  agentCredentialWrite: "seashard.agent.credential-write",
  agentCredentialRemove: "seashard.agent.credential-remove",
  agentModelConfigurationOpen: "seashard.agent.model-configuration.open",
  agentModelConfigurationChanged: "seashard.agent.model-configuration.changed",
} as const;

/** 内建运行诊断组件发布的类型化 Service contract。 */
export const runtimeDiagnosticsContract = "seashard.runtime-diagnostics";
/** 服务端核心源面向 Client 的只读 Contract。 */
export const serverCoreSourceContract = "seashard.server-core-source";
/** Modrinth 与 CurseForge 服务端资源来源面向 Client 的搜索、下载与实例安装 Contract。 */
export const serverModSourceContract = "seashard.server-mod-source";
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
/** Agent Session 的创建、读取与续写 Contract。 */
export const agentSessionContract = "seashard.agent-session";
/** Agent Invocation 的运行状态读取与取消 Contract。 */
export const agentInvocationContract = "seashard.agent-invocation";
/** Agent 模型供应商连接的结构化配置 Contract。 */
export const agentModelConfigurationContract = "seashard.agent-model-configuration";
/** 模型配置最后有效 Snapshot 变化事件。 */
export const agentModelConfigurationChangedEvent = "seashard.agent-model-configuration.changed";

export interface AgentModelSelection {
  readonly connectionId: string;
  readonly modelId: string;
}

export interface AgentConfiguredModel extends AgentModelSelection {
  readonly name: string;
}

export interface AgentModelConnectionModel {
  readonly id: string;
  readonly displayName?: string;
  readonly providerOptions?: JsonObject;
}

/** Renderer 可读取的连接投影不包含凭据正文。 */
export interface AgentModelConnectionConfig {
  readonly id: string;
  readonly displayName?: string;
  readonly providerType: string;
  readonly credentialId?: string;
  readonly credentialConfigured: boolean;
  readonly settings: JsonObject;
  readonly models?: readonly AgentModelConnectionModel[];
  readonly available: boolean;
  readonly diagnostic?: string;
}

/** Provider Type 的只读元数据；工厂和凭据只存在于 Core Host。 */
export interface AgentProviderTypeDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly settingsSchema: JsonObject;
  readonly catalog?: readonly AgentModelConnectionModel[];
  readonly supportsModelDiscovery: boolean;
}

/** revision 对应 models.yml 字节内容；diagnostics 描述未取代最后有效配置的加载故障。 */
export interface AgentModelConfigurationSnapshot {
  readonly revision: string;
  readonly connections: readonly AgentModelConnectionConfig[];
  readonly models: readonly AgentConfiguredModel[];
  readonly providerTypes: readonly AgentProviderTypeDescriptor[];
  readonly diagnostics: readonly string[];
}

export type AgentModelConnectionMutation =
  | {
      readonly op: "set";
      readonly path: readonly string[];
      readonly value: JsonValue;
    }
  | {
      readonly op: "unset";
      readonly path: readonly string[];
    };

export interface AgentModelConfigurationService {
  getConfiguration(): Promise<AgentModelConfigurationSnapshot>;
  mutateConnection(input: {
    readonly expectedRevision: string;
    readonly connectionId: string;
    readonly operations: readonly AgentModelConnectionMutation[];
  }): Promise<AgentModelConfigurationSnapshot>;
  removeConnection(input: {
    readonly expectedRevision: string;
    readonly connectionId: string;
  }): Promise<AgentModelConfigurationSnapshot>;
  /** 用户确认后以空模板替换当前配置；用于从无法结构化编辑的损坏文件恢复。 */
  resetConfiguration(input: {
    readonly expectedRevision: string;
  }): Promise<AgentModelConfigurationSnapshot>;
  /** 使用尚未写入 models.yml 的候选设置和临时凭据查询上游模型目录。 */
  discoverModels(input: {
    readonly providerType: string;
    readonly settings: JsonObject;
    readonly credentialId?: string;
    /** 只供本次发现请求使用，不写入 Host Vault。 */
    readonly credentialValue?: string;
  }): Promise<readonly AgentModelConnectionModel[]>;
  /** 明文仅作为调用参数进入 Host Vault，任何返回值和事件都不得包含它。 */
  writeCredential(input: {
    readonly credentialId: string;
    readonly value: string;
  }): Promise<AgentModelConfigurationSnapshot>;
  /** 只移除 Host Vault 中的密文，不改写 models.yml 的 credentialId 引用。 */
  removeCredential(input: {
    readonly credentialId: string;
  }): Promise<AgentModelConfigurationSnapshot>;
  openConfigurationFile(): Promise<void>;
}
/** Desktop Renderer 使用的模型设置能力；变化订阅由 Preload 转换成可释放监听器。 */
export interface AgentModelConfigurationClientService extends AgentModelConfigurationService {
  onConfigurationChanged(listener: (snapshot: AgentModelConfigurationSnapshot) => void): () => void;
}

export interface AgentUserMessage {
  readonly text: string;
}

export type AgentConversationMode = "chat" | "agent";

export interface AgentInvocationReference {
  readonly sessionId: string;
  readonly invocationId: string;
}

export type AgentInvocationState = "running" | "completed" | "cancelled" | "failed";
export type AgentToolCallState = "running" | "completed" | "cancelled" | "failed";

export interface AgentActivityPresentation {
  readonly title: string;
  readonly icon?: AgentActivityPresentationIcon;
  readonly requestPayload?: readonly AgentActivityPresentationField[];
  readonly resultPayload?: readonly AgentActivityPresentationField[];
}

/** Agent 调用工具时持久化并投影给客户端的稳定活动记录。 */
export interface AgentToolCallSnapshot {
  readonly id: string;
  readonly invocationId: string;
  readonly toolName: string;
  readonly presentation: AgentActivityPresentation;
  readonly state: AgentToolCallState;
  readonly input: JsonValue;
  readonly output?: JsonValue;
  readonly error?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

export interface AgentMessageSnapshot {
  readonly id: string;
  readonly invocationId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: string;
}

export interface AgentSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly model: AgentModelSelection;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentSessionSnapshot extends AgentSessionSummary {
  readonly messages: readonly AgentMessageSnapshot[];
  readonly toolCalls: readonly AgentToolCallSnapshot[];
}

export interface AgentInvocationSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly state: AgentInvocationState;
  readonly model: AgentModelSelection;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
}

export interface AgentInvocationSnapshot extends AgentInvocationSummary {
  readonly text: string;
  readonly toolCalls: readonly AgentToolCallSnapshot[];
}

export interface AgentSessionService {
  listModels(): Promise<readonly AgentConfiguredModel[]>;
  startSession(input: {
    initialMessage: AgentUserMessage;
    mode: AgentConversationMode;
    model?: AgentModelSelection;
  }): Promise<AgentInvocationReference>;
  sendMessage(input: {
    sessionId: string;
    message: AgentUserMessage;
    mode: AgentConversationMode;
    model?: AgentModelSelection;
  }): Promise<AgentInvocationReference>;
  listSessions(): Promise<readonly AgentSessionSummary[]>;
  getSession(sessionId: string): Promise<AgentSessionSnapshot>;
  copySession(sessionId: string): Promise<AgentSessionSummary>;
  renameSession(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface AgentInvocationService {
  getInvocation(invocationId: string): Promise<AgentInvocationSnapshot>;
  cancelInvocation(invocationId: string): Promise<void>;
}

export interface AgentClientService
  extends
    Pick<
      AgentSessionService,
      | "listModels"
      | "startSession"
      | "sendMessage"
      | "listSessions"
      | "getSession"
      | "copySession"
      | "deleteSession"
    >,
    AgentInvocationService {}

/** 面向客户端的单个插件运行视图。 */
export type ComponentSnapshot = {
  id: string;
  displayName: string;
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

export type ServerModSource = "modrinth" | "curseforge";
/** 判断来源是否具备当前目录查询与详情跳转实现。 */
export function isServerModSource(value: unknown): value is ServerModSource {
  return value === "modrinth" || value === "curseforge";
}
export type ServerModrinthResourceType = "mod" | "modpack" | "datapack" | "world";
export type ServerModDownloadableResourceType = ServerModrinthResourceType;
export const serverModLoaders = ["fabric", "forge", "neoforge", "quilt"] as const;
export type ServerModLoader = (typeof serverModLoaders)[number];

const serverCoreModLoaders: Readonly<Record<string, ServerModLoader>> = {
  "arclight-fabric": "fabric",
  "arclight-forge": "forge",
  "arclight-neoforge": "neoforge",
  banner: "fabric",
  catserver: "forge",
  fabric: "fabric",
  mohist: "forge",
  neoforge: "neoforge",
  quilt: "quilt",
  spongeforge: "forge",
  youer: "neoforge",
};

/** 由核心类型确定实例实际支持的 Mod 加载器；纯插件端和原版核心返回 null。 */
export function serverModLoaderForCoreType(value: unknown): ServerModLoader | null {
  return typeof value === "string" ? (serverCoreModLoaders[value] ?? null) : null;
}
export type ServerModSearchIndex = "relevance" | "downloads" | "follows" | "newest" | "updated";
export type ServerModEnvironment =
  | "client_and_server"
  | "server_only"
  | "server_only_client_optional"
  | "dedicated_server_only"
  | "client_or_server"
  | "client_or_server_prefers_both"
  | "client_only_server_optional"
  | "client_only";

/** 搜索分页的默认值与边界；Host 会再次校验，避免 Renderer 发起无界请求。 */
export const serverModSearchLimits = {
  pageSize: 20,
  maximumPageSize: 50,
  maximumQueryLength: 200,
} as const;

export interface ServerModFilterOption {
  id: string;
  label: string;
}

/** 单个服务端资源来源的筛选元数据；来源暂时不可用时保留可验证的提示。 */
export interface ServerModFilters {
  sources: readonly ServerModFilterOption[];
  tags: readonly ServerModFilterOption[];
  versions: readonly ServerModFilterOption[];
  loaders: readonly ServerModFilterOption[];
  unavailableReason?: string;
}

/** Client 只能提交声明式筛选条件，不能传入任意上游 URL 或 Facet 表达式。 */
export interface ServerModSearchRequest {
  resourceType: ServerModrinthResourceType;
  source: ServerModSource;
  query: string;
  tag: string;
  index: ServerModSearchIndex;
  gameVersion: string;
  loader: string;
  offset: number;
  limit: number;
}

/** 多来源 Mod 搜索结果的最小安全投影；图标仅允许来自受信任的上游 CDN。 */
export interface ServerModProject {
  resourceType: ServerModrinthResourceType;
  source: ServerModSource;
  id: string;
  slug: string;
  title: string;
  iconUrl?: string;
  description: string;
  author: string;
  downloads: number;
  follows: number;
  dateModified: string;
  environment: readonly ServerModEnvironment[];
  categories: readonly string[];
  versions: readonly string[];
}

export interface ServerModSearchResult {
  items: readonly ServerModProject[];
  offset: number;
  limit: number;
  total: number;
  unavailableReason?: string;
}
/** 详情页中的单个可下载版本；Host 只投影列表展示所需字段。 */
export interface ServerModVersion {
  id: string;
  gameVersions: readonly string[];
  loaders: readonly string[];
  fileName: string;
  downloads: number;
  datePublished: string;
}

/** 多来源项目长简介及其全部公开版本。 */
export interface ServerModProjectDetails {
  resourceType: ServerModrinthResourceType;
  source: ServerModSource;
  projectId: string;
  project: ServerModProject;
  body: string;
  versions: readonly ServerModVersion[];
}
export type ServerResourceSourceType = "mod" | "datapack" | "world";
export type ServerResourceSource = string;

/** 已安装资源的来源标识；未知来源只保留展示信息，不自动生成来源跳转。 */
export interface ServerResourceSourceMetadata {
  source: ServerResourceSource;
  id: string;
  /** 来源发布版本的显示标签，例如 Modrinth 的 version_number。 */
  version?: string;
  iconUrl?: string;
}

/** 实例 seashard.json 中按对应资源存储根目录的相对路径保存资源来源索引。 */
export interface ServerResourceSourceIndex {
  mods?: Readonly<Record<string, ServerResourceSourceMetadata>>;
  datapacks?: Readonly<Record<string, ServerResourceSourceMetadata>>;
  worlds?: Readonly<Record<string, ServerResourceSourceMetadata>>;
}

/** Host 写入资源来源索引时使用的单条记录。 */
export interface ServerResourceSourceRecord extends ServerResourceSourceMetadata {
  resourceType: ServerResourceSourceType;
  relativePath: string;
}

/** Renderer 只提交来源、资源类型、项目身份和已登记实例 ID；数据包还要提交已选择的存档 ID。 */
export interface ServerModInstallRequest {
  source: ServerModSource;
  resourceType: "mod" | "datapack" | "world";
  projectId: string;
  versionId: string;
  instanceId: string;
  /** 仅数据包安装使用；Host 会再次确认它属于该实例且确实存在。 */
  worldId?: string;
}

/** “另存为”同样只提交来源、资源类型和项目身份，目标目录由 Desktop 系统对话框选择。 */
export interface ServerModSaveAsRequest {
  source: ServerModSource;
  resourceType: ServerModDownloadableResourceType;
  projectId: string;
  versionId: string;
}
/** 多来源资源完成校验并发布后的稳定结果。 */
export interface ServerModDownloadResult {
  source: ServerModSource;
  resourceType: ServerModDownloadableResourceType;
  projectId: string;
  versionId: string;
  fileName: string;
  destination: "instance" | "directory";
  instanceId?: string;
  downloadedBytes: number;
}
export interface ServerModSourceClientService {
  getFilters(
    resourceType: ServerModrinthResourceType,
    source: ServerModSource,
  ): Promise<ServerModFilters>;
  search(request: ServerModSearchRequest): Promise<ServerModSearchResult>;
  getProjectDetails(
    resourceType: ServerModrinthResourceType,
    source: ServerModSource,
    projectId: string,
  ): Promise<ServerModProjectDetails>;
  installToInstance(request: ServerModInstallRequest): Promise<ServerModDownloadResult>;
  saveAs(request: ServerModSaveAsRequest): Promise<ServerModDownloadResult | undefined>;
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

export type FileDownloadTaskState = "queued" | "downloading" | "completed" | "failed" | "cancelled";
export type ServerCoreDownloadTaskState = FileDownloadTaskState;

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

/** 顶栏文件下载条使用的公共任务投影，不向 Renderer 暴露远端 URL 与业务 metadata。 */
export interface FileDownloadTaskSnapshot {
  id: string;
  destinationPath: string;
  state: FileDownloadTaskState;
  downloadedBytes: number;
  totalBytes: number;
  connections: number;
  progress: number;
  createdAt: string;
  finishedAt?: string;
  error?: string;
}

export interface FileDownloadClientService {
  listTasks(): Promise<readonly FileDownloadTaskSnapshot[]>;
  cancel(taskId: string): Promise<boolean>;
}

/** 顶栏和下载页共享的服务器核心任务投影。 */
export interface ServerCoreDownloadTaskSnapshot extends FileDownloadTaskSnapshot {
  artifact: ServerCoreArtifact;
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

/** 单个服务器实例持久化的完整启动参数；存在时整体覆盖全局启动默认值。 */
export interface ServerInstanceStartupSettings {
  minimumMemoryMiB: number;
  maximumMemoryMiB: number;
  serverPort: number;
  autoAcceptEula: boolean;
  jvmArguments: string;
}

/** 服务器事实与 SeaShard 私有 JSON 合并后的稳定 Client 投影。 */
export interface ServerInstanceSnapshot {
  id: string;
  name: string;
  rootPath: string;
  coreJarPath: string;
  iconPath?: string;
  /** 世界下载外层目录的完整名称；例如 worlds-abc123。 */
  worldStorageDirectoryName?: string;
  /** 世界备份外层目录的完整名称；例如 backups-def456。 */
  backupDirectoryName?: string;
  storageMode: ServerInstanceStorageMode;
  source: ServerInstanceSource;
  /** 核心对应的标准 Mod 加载器；纯插件端、代理端和原版核心为 null。 */
  modLoader: ServerModLoader | null;
  serverType?: string;
  gameVersion?: string;
  coreArtifactFileName?: string;
  artifactSha256?: string;
  createdAt: string;
  updatedAt: string;
  iconUrl?: string;
  lastStartedAt?: string;
  /** 已完成运行会话的累计时长；当前会话由 Client 根据 startedAt 实时叠加。 */
  totalRuntimeMs?: number;
  /** 保存后整体覆盖全局启动默认值；缺省表示继续继承全局设置。 */
  startupSettings?: ServerInstanceStartupSettings;
  /** 本地资源到来源展示信息的可选索引；不参与资源归属和版本判断。 */
  resourceSources?: ServerResourceSourceIndex;
}

export type ServerWorldStorageMode = "unified" | "split";
export type ServerWorldDimension = "overworld" | "nether" | "end";
export type ServerWorldDatapackKind = "archive" | "directory";

/** 一个可切换的世界目录；split 模式下同一组的多个维度共享 groupId。 */
export interface ServerWorldSave {
  id: string;
  groupId: string;
  name: string;
  dimension: ServerWorldDimension;
  current: boolean;
  createdAt?: string;
  resourceSource?: ServerResourceSourceMetadata;
  updatedAt?: string;
  iconDataUrl?: string;
}

/** 一个世界备份的稳定投影；路径仅返回文件名，不暴露宿主绝对路径。 */
export interface ServerWorldBackupSnapshot {
  instanceId: string;
  worldId: string;
  worldDirectoryName: string;
  fileName: string;
  createdAt: string;
  sizeBytes: number;
}

/** 一个世界数据包的稳定投影；路径仅返回世界数据包目录中的文件名。 */
export interface ServerWorldDatapackSnapshot {
  instanceId: string;
  worldId: string;
  resourceSource?: ServerResourceSourceMetadata;
  fileName: string;
  kind: ServerWorldDatapackKind;
  disabled: boolean;
  /** 从 pack.mcmeta 读取的简短介绍。 */
  description?: string;
  /** 数据包内部 pack.png 的数据地址。 */
  iconDataUrl?: string;
  updatedAt: string;
}

/** 一个已安装 MOD 的稳定投影；relativePath 是实例根目录下的 POSIX 相对路径。 */
export interface ServerInstalledModSnapshot {
  instanceId: string;
  relativePath: string;
  fileName: string;
  name: string;
  version?: string;
  /** 从 MOD 清单读取的简短介绍。 */
  description?: string;
  /** MOD JAR 内部图标的数据地址。 */
  iconDataUrl?: string;
  /** 文件首次落盘时间；手动复制的 MOD 使用文件系统创建时间。 */
  addedAt: string;
  disabled: boolean;
  resourceSource?: ServerResourceSourceMetadata;
}

export interface ServerWorldDimensionGroup {
  id: string;
  name: string;
  current: boolean;
  saves: readonly ServerWorldSave[];
}

/** Host 扫描实例目录后发布的存档稳定投影，不向 Renderer 暴露绝对路径。 */
export interface ServerWorldStorageSnapshot {
  instanceId: string;
  mode: ServerWorldStorageMode;
  currentId?: string;
  saves: readonly ServerWorldSave[];
  dimensions: readonly ServerWorldDimensionGroup[];
}

/** Renderer 读取指定实例的已安装 MOD，并通过重命名切换启用状态。 */
export interface ServerInstanceModService {
  listMods(instanceId: string): Promise<readonly ServerInstalledModSnapshot[]>;
  setModDisabled(
    instanceId: string,
    relativePath: string,
    disabled: boolean,
  ): Promise<ServerInstalledModSnapshot>;
  deleteMod(instanceId: string, relativePath: string): Promise<void>;
}

/** 当前实例中可发现的世界存档及其维度布局。 */
export interface ServerInstanceWorldService {
  listWorldStorage(instanceId: string): Promise<ServerWorldStorageSnapshot>;
  listWorldDatapacks(
    instanceId: string,
    worldId: string,
  ): Promise<readonly ServerWorldDatapackSnapshot[]>;
  setWorldDatapackDisabled(
    instanceId: string,
    worldId: string,
    fileName: string,
    disabled: boolean,
  ): Promise<ServerWorldDatapackSnapshot>;
  deleteWorldDatapack(instanceId: string, worldId: string, fileName: string): Promise<void>;
  switchWorld(instanceId: string, worldId: string): Promise<ServerWorldStorageSnapshot>;
  listWorldBackups(
    instanceId: string,
    worldId: string,
  ): Promise<readonly ServerWorldBackupSnapshot[]>;
  createWorldBackup(instanceId: string, worldId: string): Promise<ServerWorldBackupSnapshot>;
  restoreWorldBackup(
    instanceId: string,
    worldId: string,
    fileName: string,
  ): Promise<ServerWorldStorageSnapshot>;
  deleteWorldBackup(instanceId: string, worldId: string, fileName: string): Promise<void>;
}

/** Renderer 只读取已登记实例及其世界存档，不接触宿主文件系统。 */
export interface ServerInstanceContentCounts {
  mods: number;
  plugins: number;
}

/** Renderer 只读取已经完成注册的实例，不接触 JSON 文件、SQLite 或临时下载状态。 */
export interface ServerInstanceClientService
  extends ServerInstanceWorldService, ServerInstanceModService {
  list(): Promise<readonly ServerInstanceSnapshot[]>;
  /** 统计已登记实例内的 Mod 与插件 JAR，不向 Renderer 暴露目录扫描能力。 */
  contentCounts(instanceId: string): Promise<ServerInstanceContentCounts>;
  /** 保存实例专属启动参数；该完整设置组优先于全局启动默认值。 */
  setStartupSettings(
    instanceId: string,
    settings: ServerInstanceStartupSettings,
  ): Promise<ServerInstanceSnapshot>;
  /** 保存实例自定义图标并返回最新实例投影。 */
  setIcon(instanceId: string, iconDataUrl: string): Promise<ServerInstanceSnapshot>;
  /** 仅按已登记实例 ID 请求宿主打开实例根目录，不接受 Renderer 提交任意路径。 */
  openFolder(instanceId: string): Promise<void>;
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
/** 可接收普通 Java 世界存档的核心；Paper 系列会在启动时自动转换其维度布局。 */
const unifiedWorldServerTypes = new Set([
  "vanilla",
  "vanilla-snapshot",
  "forge",
  "fabric",
  "quilt",
  "neoforge",
  "spongeforge",
  "spongevanilla",
  "paper",
  "purpur",
  "folia",
  "pufferfish",
  "pufferfish_purpur",
  "leaf",
  "leaves",
  // Arclight 默认使用原版维度目录；开启 symlink-world 后才额外生成 Bukkit 映射。
  "arclight-fabric",
  "arclight-forge",
  "arclight-neoforge",
  // 这三个混合核心的实测首个世界均为单根目录 + DIM/维度目录。
  "banner",
  "mohist",
  "youer",
]);

export function supportsUnifiedWorldStorage(value: unknown): boolean {
  return typeof value === "string" && unifiedWorldServerTypes.has(value);
}

/** Renderer 与 Host 共享同一支持列表，避免页面和进程管理器各维护一份条件链。 */
export function isServerRuntimeSupportedType(value: unknown): value is ServerRuntimeSupportedType {
  return (
    typeof value === "string" && (serverRuntimeSupportedTypes as readonly string[]).includes(value)
  );
}

export type ServerProcessState = "stopped" | "starting" | "running" | "stopping" | "failed";
export type ServerConsoleStream = "stdout" | "stderr" | "input" | "system";

/** 启动组件根据当前 Java 选择和核心策略生成的等价命令行。 */
export interface ServerLaunchCommandPreview {
  instanceId: string;
  command: string;
}

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
  preview(
    instanceId: string,
    startupSettings?: ServerInstanceStartupSettings,
  ): Promise<ServerLaunchCommandPreview>;
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
  agent: AgentClientService;
  serverCore: ServerCoreSourceClientService;
  agentModels: AgentModelConfigurationClientService;
  serverSettings: ServerSettingsClientService;
  serverCoreDownload: ServerCoreDownloadClientService;
  fileDownloads: FileDownloadClientService;
  serverMods: ServerModSourceClientService;
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
