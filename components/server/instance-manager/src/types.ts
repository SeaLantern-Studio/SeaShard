import type {
  ServerCoreManagedDownloadResult,
  ServerCoreManagedDownloadRequest,
  ServerInstanceSnapshot,
  ServerInstanceContentCounts,
  ServerInstanceStartupSettings,
  ServerModLoader,
  ServerWorldStorageSnapshot,
} from "@seashard/contracts";

export {
  serverInstanceManagerContract,
  type ServerInstanceSnapshot,
  type ServerInstanceSource,
  type ServerInstanceStorageMode,
} from "@seashard/contracts";

/** Host 侧创建托管实例时补入设置组件保存的下载并发数。 */
export interface CreateManagedServerInstanceRequest extends ServerCoreManagedDownloadRequest {
  connections: number;
}
/** 一次世界备份的结果；只在 Host 实例管理组件内部传递，不暴露给 Renderer 合同。 */
export interface ServerWorldBackupSnapshot {
  readonly instanceId: string;
  readonly worldId: string;
  readonly worldDirectoryName: string;
  readonly fileName: string;
  readonly createdAt: string;
  readonly sizeBytes: number;
}

/** 实例组件供 Desktop Shell 和后续进程管理组件使用的宿主能力。 */
export interface ServerInstanceManagerService {
  /** 下载服务端核心；校验成功后写入双 JSON，并在 SQLite 登记 seashard.json 路径。 */
  createManaged(
    request: CreateManagedServerInstanceRequest,
  ): Promise<ServerCoreManagedDownloadResult>;
  /** 从路径索引读取并合并 server.json 与 seashard.json。 */
  list(): Promise<readonly ServerInstanceSnapshot[]>;
  /** 持久化实例专属启动参数，并返回更新后的完整实例投影。 */
  setStartupSettings(
    instanceId: string,
    settings: ServerInstanceStartupSettings,
  ): Promise<ServerInstanceSnapshot>;
  /** 统计实例标准 Mod 与插件目录中的 JAR 文件。 */
  contentCounts(instanceId: string): Promise<ServerInstanceContentCounts>;
  /** 列出实例下的原生世界、下载世界或分维度世界。 */
  listWorldStorage(instanceId: string): Promise<ServerWorldStorageSnapshot>;
  /** 创建指定逻辑世界的 ZIP 备份；调用方负责保证服务端已停机。 */
  createWorldBackup(instanceId: string, worldId: string): Promise<ServerWorldBackupSnapshot>;
  /** 修改实例 server.properties 的 level-name；Desktop Shell 负责运行态停机门禁。 */
  switchWorld(instanceId: string, worldId: string): Promise<ServerWorldStorageSnapshot>;
  /** 服务器进程成功启动后，持久化最近启动时间供跨会话统计使用。 */
  recordStartedAt(instanceId: string, startedAt: string): Promise<void>;
  /** 服务器进程退出后，将本次运行区间累加到实例总运行时长。 */
  recordRuntime(instanceId: string, startedAt: string, stoppedAt: string): Promise<void>;
  /** 删除托管目录和 SQLite 中对应的 manifest 路径记录。 */
  delete(instanceId: string): Promise<void>;
  /** 只按已注册实例 ID 解析实例内图标，不接受调用方传入任意路径。 */
  resolveIconPath(instanceId: string): Promise<string | null>;
}

/** 服务器自身事实；所有路径均相对实例根目录。 */
export interface PortableServerInformationManifest {
  schemaVersion: 1;
  minecraft: {
    version?: string;
  };
  modLoader: ServerModLoader | null;
  core: {
    path: string;
    type?: string;
    artifact?: {
      fileName?: string;
      sha256?: string;
    };
  };
}

/** 仅供 SeaShard 使用的实例管理数据；icon 相对元数据目录。 */
export interface PortableSeaShardInstanceManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  storageMode: "managed" | "external";
  source: "downloaded" | "imported";
  icon?: string;
  startupSettings?: ServerInstanceStartupSettings;
  lastStartedAt?: string;
  totalRuntimeMs?: number;
  createdAt: string;
  updatedAt: string;
}
