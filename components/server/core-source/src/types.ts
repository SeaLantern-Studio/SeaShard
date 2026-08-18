import type {
  ServerCoreArtifact,
  ServerCoreDownloadTaskSnapshot,
  ServerCoreType,
} from "@seashard/contracts";

export {
  serverCoreSourceContract,
  type ServerCoreArtifact,
  type ServerCoreDownloadTaskSnapshot,
  type ServerCoreDownloadTaskState,
  type ServerCoreType,
} from "@seashard/contracts";

export const defaultCnbCatalogUrl =
  "https://cnb.cool/SeaLantern-studio/ServerCore-Mirror/-/releases/download/26.02.27/jar_lfs_links.json";
export const defaultCnbIconCatalogUrl =
  "https://cnb.cool/SeaLantern-studio/ServerCore-Mirror/-/releases/download/26.02.27/icon_lfs_links.json";

/** Host 侧下载请求；目录由 Client 平台选择，产物身份仍由核心目录验证。 */
export interface StartServerCoreDownloadRequest {
  serverType: string;
  gameVersion: string;
  destinationDirectory: string;
  artifactFileName: string;
  destinationFileName: string;
  connections: number;
}

/** 服务端核心源组件提供给创建、升级、UI 和 Agent 的公共能力。 */
export interface ServerCoreSourceService {
  /** 列出 CNB 目录中的全部服务端类型。 */
  listTypes(): Promise<readonly ServerCoreType[]>;
  /** 将本地协议中的内容哈希解析成已验证缓存文件；不向 Renderer 暴露真实路径。 */
  resolveIconPath(sha256: string): Promise<string | null>;
  /** 列出指定服务端类型支持的游戏版本。 */
  listVersions(serverType: string): Promise<readonly string[]>;
  /** 返回指定类型和版本下经过校验的下载产物。 */
  listArtifacts(serverType: string, gameVersion: string): Promise<readonly ServerCoreArtifact[]>;
  /** 创建后台下载任务并立即返回初始快照。 */
  start(request: StartServerCoreDownloadRequest): Promise<ServerCoreDownloadTaskSnapshot>;
  /** 查询单个任务；任务不存在时返回 null。 */
  snapshot(taskId: string): Promise<ServerCoreDownloadTaskSnapshot | null>;
  /** 等待任务进入终态；实例管理器据此决定注册或清理托管目录。 */
  wait(taskId: string): Promise<ServerCoreDownloadTaskSnapshot | null>;
  /** 按创建时间返回当前保留的任务快照。 */
  listTasks(): Promise<readonly ServerCoreDownloadTaskSnapshot[]>;
  /** 取消未进入终态的任务，并等待临时文件清理完成。 */
  cancel(taskId: string): Promise<boolean>;
}
