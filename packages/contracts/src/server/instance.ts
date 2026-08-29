import type {
  ServerModLoader,
  ServerResourceSourceIndex,
  ServerResourceSourceMetadata,
} from "./resource";

/** 服务器实例管理 Contract；Host 完整类型由实例管理组件关联。 */
export const serverInstanceManagerContract = "seashard.server-instance-manager";
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

/**
 * 一个可切换的世界目录。
 * id 只发布实际世界目录的末级名称；下载世界的外层 Host 容器永远不进入公开身份。
 */
export interface ServerWorldSave {
  id: string;
  /** split 模式下同一组的多个维度共享末级逻辑世界 ID。 */
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
  /** 可直接提交给世界、数据包和备份能力的末级逻辑世界 ID。 */
  id: string;
  name: string;
  current: boolean;
  saves: readonly ServerWorldSave[];
}

/** Host 扫描实例目录后发布的存档稳定投影，不暴露绝对路径或外层存储容器。 */
export interface ServerWorldStorageSnapshot {
  instanceId: string;
  mode: ServerWorldStorageMode;
  /** 当前世界的末级逻辑 ID；server.properties 可在 Host 内继续保存完整相对路径。 */
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
