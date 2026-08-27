import type { ServerCoreArtifact } from "./core";

/** 当前 Client 平台提供的服务器核心下载交互；Desktop 使用系统目录选择窗口。 */
export const serverCoreDownloadContract = "seashard.server-core-download";
/** 默认下载并发数的稳定边界；服务端设置和公共下载器必须保持一致。 */
export const serverDownloadConnectionLimits = {
  minimum: 1,
  maximum: 32,
  defaultValue: 8,
} as const;
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
