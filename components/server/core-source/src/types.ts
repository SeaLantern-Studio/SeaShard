import {
  serverCoreSourceContract as serverCoreSourceContractId,
  type ServerCoreArtifact,
  type ServerCoreDownloadTaskSnapshot,
  type ServerCoreType,
} from "@seashard/contracts";
import { defineServiceContract } from "@seashard/plugin-sdk";

export {
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
  /**
   * 列出 CNB 目录中的全部服务端类型。
   *
   * @returns 带名称、能力和图标哈希的核心类型。
   */
  listTypes(): Promise<readonly ServerCoreType[]>;
  /**
   * 将本地协议中的内容哈希解析成已验证缓存文件，不向 Renderer 暴露真实路径。
   *
   * @param sha256 目录声明的十六进制 SHA-256。
   * @returns 已验证缓存路径，缓存不存在时返回 null。
   */
  resolveIconPath(sha256: string): Promise<string | null>;
  /**
   * 列出指定服务端类型支持的游戏版本。
   *
   * @param serverType 目录中的服务端类型 ID。
   * @returns 可用 Minecraft 版本。
   */
  listVersions(serverType: string): Promise<readonly string[]>;
  /**
   * 返回指定类型和版本下经过校验的下载产物。
   *
   * @param serverType 目录中的服务端类型 ID。
   * @param gameVersion Minecraft 版本。
   * @returns 可下载核心产物。
   */
  listArtifacts(serverType: string, gameVersion: string): Promise<readonly ServerCoreArtifact[]>;
  /**
   * 创建后台下载任务并立即返回初始快照。
   *
   * @param request 核心身份、目标目录、文件名和并发数。
   * @returns 新核心下载任务的初始快照。
   */
  start(request: StartServerCoreDownloadRequest): Promise<ServerCoreDownloadTaskSnapshot>;
  /**
   * 查询单个任务；任务不存在时返回 null。
   *
   * @param taskId 核心下载任务 ID。
   * @returns 当前任务快照或 null。
   */
  snapshot(taskId: string): Promise<ServerCoreDownloadTaskSnapshot | null>;
  /**
   * 等待任务进入终态；实例管理器据此决定注册或清理托管目录。
   *
   * @param taskId 核心下载任务 ID。
   * @returns 结算后的任务快照或 null。
   */
  wait(taskId: string): Promise<ServerCoreDownloadTaskSnapshot | null>;
  /**
   * 按创建时间返回当前保留的任务快照。
   *
   * @returns 当前保留的全部核心下载任务。
   */
  listTasks(): Promise<readonly ServerCoreDownloadTaskSnapshot[]>;
  /**
   * 取消未进入终态的任务，并等待临时文件清理完成。
   *
   * @param taskId 核心下载任务 ID。
   * @returns 是否成功取消了尚未结算的任务。
   */
  cancel(taskId: string): Promise<boolean>;
}

/** 将共享 Contract 标识关联到核心源组件实际发布的完整 Host Service。 */
export const serverCoreSourceContract = defineServiceContract<ServerCoreSourceService>(
  serverCoreSourceContractId,
);
