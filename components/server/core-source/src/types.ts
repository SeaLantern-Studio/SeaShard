import type { ServerCoreArtifact } from "@seashard/contracts";

export { serverCoreSourceContract, type ServerCoreArtifact } from "@seashard/contracts";

export const defaultCnbCatalogUrl =
  "https://cnb.cool/SeaLantern-studio/ServerCore-Mirror/-/releases/download/26.02.27/jar_lfs_links.json";

/** 下载任务的完整生命周期；终态为 completed、failed 或 cancelled。 */
export type ServerCoreSourceTaskState =
  | "queued"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled";

/** 启动下载所需的稳定业务参数，不允许调用方直接传入任意下载地址。 */
export interface StartServerCoreDownloadRequest {
  serverType: string;
  gameVersion: string;
  serverDirectory: string;
  fileName?: string;
}

/** 对外暴露的任务快照；组件内部的控制器和 Promise 不会穿过服务边界。 */
export interface ServerCoreDownloadTaskSnapshot {
  id: string;
  artifact: ServerCoreArtifact;
  destinationPath: string;
  state: ServerCoreSourceTaskState;
  downloadedBytes: number;
  totalBytes: number;
  connections: number;
  progress: number;
  createdAt: string;
  finishedAt?: string;
  error?: string;
}

/** 服务端核心源组件提供给创建、升级、UI 和 Agent 的公共能力。 */
export interface ServerCoreSourceService {
  /** 列出 CNB 目录中的全部服务端类型。 */
  listTypes(): Promise<readonly string[]>;
  /** 列出指定服务端类型支持的游戏版本。 */
  listVersions(serverType: string): Promise<readonly string[]>;
  /** 返回指定类型和版本下经过校验的下载产物。 */
  listArtifacts(serverType: string, gameVersion: string): Promise<readonly ServerCoreArtifact[]>;
  /** 创建后台下载任务并立即返回初始快照。 */
  start(request: StartServerCoreDownloadRequest): Promise<ServerCoreDownloadTaskSnapshot>;
  /** 查询单个任务；任务不存在时返回 null。 */
  snapshot(taskId: string): Promise<ServerCoreDownloadTaskSnapshot | null>;
  /** 按创建时间返回当前保留的任务快照。 */
  listTasks(): Promise<readonly ServerCoreDownloadTaskSnapshot[]>;
  /** 取消未进入终态的任务，并等待临时文件清理完成。 */
  cancel(taskId: string): Promise<boolean>;
}
