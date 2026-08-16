import type { JsonValue } from "@seashard/plugin-sdk";

export const downloadContract = "seashard.download";

export type DownloadTaskState = "queued" | "downloading" | "completed" | "failed" | "cancelled";

/**
 * 公共下载组件接收完整目标文件路径，而不是某一种业务目录。
 *
 * 服务端、模组、插件和自定义文件组件负责决定自己的目录结构与最终文件名。
 */
export interface StartDownloadRequest {
  readonly url: string;
  readonly destinationPath: string;
  readonly expectedBytes?: number;
  readonly sha256?: string;
  /** 期望的并发连接数；远端不支持 Range 时自动退回单连接。 */
  readonly connections?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly metadata?: JsonValue;
}

/** 公共下载任务快照；metadata 由创建任务的业务组件解释。 */
export interface DownloadTaskSnapshot {
  readonly id: string;
  readonly url: string;
  readonly destinationPath: string;
  readonly state: DownloadTaskState;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  /** 实际使用的连接数；探测完成前为 0。 */
  readonly connections: number;
  readonly progress: number;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
  readonly metadata?: JsonValue;
}

/** 所有需要下载文件的组件都通过这一份进程级服务创建和管理任务。 */
export interface DownloadService {
  /** 创建后台下载任务并立即返回初始快照。 */
  start(request: StartDownloadRequest): Promise<DownloadTaskSnapshot>;
  /** 查询单个任务；任务不存在时返回 null。 */
  snapshot(taskId: string): Promise<DownloadTaskSnapshot | null>;
  /** 按创建时间返回当前保留的任务。 */
  listTasks(): Promise<readonly DownloadTaskSnapshot[]>;
  /** 取消任务并等待临时文件清理完成。 */
  cancel(taskId: string): Promise<boolean>;
}

/**
 * 每次新建任务时返回当前 HTTP 实现。
 *
 * 代理配置变化后，宿主只需让 Provider 返回新的代理感知实现；后续任务无需重启组件。
 */
export type DownloadFetchProvider = () => typeof globalThis.fetch;

export interface DownloadManagerOptions {
  readonly fetchProvider?: DownloadFetchProvider;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly defaultConnections?: number;
  readonly maxConnections?: number;
  readonly minimumChunkBytes?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly maxRetainedTasks?: number;
}
