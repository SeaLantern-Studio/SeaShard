import type {
  ServerCoreManagedDownloadResult,
  ServerCoreManagedDownloadRequest,
  ServerInstanceSnapshot,
  ServerModLoader,
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

/** 实例组件供 Desktop Shell 和后续进程管理组件使用的宿主能力。 */
export interface ServerInstanceManagerService {
  /** 下载服务端核心；校验成功后写入双 JSON，并在 SQLite 登记 seashard.json 路径。 */
  createManaged(
    request: CreateManagedServerInstanceRequest,
  ): Promise<ServerCoreManagedDownloadResult>;
  /** 从路径索引读取并合并 server.json 与 seashard.json。 */
  list(): Promise<readonly ServerInstanceSnapshot[]>;
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
  lastStartedAt?: string;
  totalRuntimeMs?: number;
  createdAt: string;
  updatedAt: string;
}
