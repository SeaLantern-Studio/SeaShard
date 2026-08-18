import { serverDownloadConnectionLimits } from "@seashard/contracts";
import type { DownloadService, DownloadTaskSnapshot } from "@seashard/download";
import { access } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type { CnbServerCoreCatalog } from "./cnb-catalog";
import type {
  ServerCoreArtifact,
  ServerCoreDownloadTaskSnapshot,
  StartServerCoreDownloadRequest,
} from "./types";

const metadataKind = "server-core";
const usesCaseInsensitivePaths = process.platform === "win32";

interface DestinationReservation {
  readonly path: string;
  readonly key: string;
}

/**
 * 把“服务端类型 + 游戏版本”翻译为公共下载任务。
 *
 * 本类不读写网络流，也不管理 .part 文件；这些通用职责全部委托给 seashard.download。
 */
export class ServerCoreSourceCoordinator {
  private readonly ownedTaskIds = new Set<string>();
  private readonly reservedDestinationPaths = new Set<string>();
  private disposed = false;

  constructor(
    private readonly catalog: CnbServerCoreCatalog,
    private readonly downloads: DownloadService,
  ) {}

  /** 验证目录中的 CNB 产物，并按调用方给出的安全文件名启动公共多连接下载。 */
  async start(value: unknown): Promise<ServerCoreDownloadTaskSnapshot> {
    if (this.disposed) throw new Error("server core source coordinator is stopped");
    const request = parseStartRequest(value);
    const artifacts = await this.catalog.listArtifacts(request.serverType, request.gameVersion);
    // 目录请求期间组件可能被停止，因此跨越 await 后必须重新检查生命周期。
    if (this.disposed) throw new Error("server core source coordinator is stopped");
    const artifact = selectArtifact(artifacts, request.artifactFileName);
    if (!isAbsolute(request.destinationDirectory)) {
      throw new TypeError("server core download destination directory must be absolute");
    }
    const destinationDirectory = resolve(request.destinationDirectory);
    const requestedDestinationPath = resolve(destinationDirectory, request.destinationFileName);
    if (
      dirname(requestedDestinationPath) !== destinationDirectory ||
      basename(requestedDestinationPath) !== request.destinationFileName
    ) {
      throw new TypeError("server core download destination escaped the selected directory");
    }

    const reservation = await this.reserveDestinationPath(
      destinationDirectory,
      request.destinationFileName,
    );
    try {
      if (this.disposed) throw new Error("server core source coordinator is stopped");
      const task = await this.downloads.start({
        url: artifact.url,
        destinationPath: reservation.path,
        sha256: artifact.sha256,
        connections: request.connections,
        metadata: {
          kind: metadataKind,
          artifact: { ...artifact },
        },
      });
      // start 与组件停止存在竞态；停止已经开始时，不能把新任务遗留给公共下载器。
      if (this.disposed) {
        await this.downloads.cancel(task.id);
        throw new Error("server core source coordinator is stopped");
      }
      this.ownedTaskIds.add(task.id);
      return toServerSnapshot(task);
    } finally {
      this.reservedDestinationPaths.delete(reservation.key);
    }
  }

  /**
   * 目标被已有文件或活动任务占用时，在扩展名前依次追加 (1)、(2)。
   * 候选路径在磁盘检查期间先占位，避免并发请求选中同一个尚未创建的文件。
   */
  private async reserveDestinationPath(
    directory: string,
    requestedFileName: string,
  ): Promise<DestinationReservation> {
    const activeDestinationPaths = new Set<string>();
    for (const task of await this.downloads.listTasks()) {
      if (task.state === "queued" || task.state === "downloading") {
        activeDestinationPaths.add(destinationKey(task.destinationPath));
      }
    }

    for (let copyNumber = 0; ; copyNumber += 1) {
      const fileName = appendCopyNumber(requestedFileName, copyNumber);
      const candidatePath = resolve(directory, fileName);
      const key = destinationKey(candidatePath);
      if (activeDestinationPaths.has(key) || this.reservedDestinationPaths.has(key)) continue;

      this.reservedDestinationPaths.add(key);
      try {
        if (!(await pathExists(candidatePath))) return { path: candidatePath, key };
      } catch (error) {
        this.reservedDestinationPaths.delete(key);
        throw error;
      }
      this.reservedDestinationPaths.delete(key);
    }
  }

  /** 只允许通过服务端核心组件查询自己创建的公共下载任务。 */
  async snapshot(taskId: string): Promise<ServerCoreDownloadTaskSnapshot | undefined> {
    if (!this.ownedTaskIds.has(taskId)) return undefined;
    const task = await this.downloads.snapshot(taskId);
    if (!task) {
      this.ownedTaskIds.delete(taskId);
      return undefined;
    }
    return toServerSnapshot(task);
  }

  /** 等待本组件创建的任务进入终态，避免业务组件轮询公共下载器。 */
  async wait(taskId: string): Promise<ServerCoreDownloadTaskSnapshot | undefined> {
    if (!this.ownedTaskIds.has(taskId)) return undefined;
    const task = await this.downloads.wait(taskId);
    if (!task) {
      this.ownedTaskIds.delete(taskId);
      return undefined;
    }
    return toServerSnapshot(task);
  }

  /** 从统一下载中心中过滤出本组件拥有的任务。 */
  async listTasks(): Promise<readonly ServerCoreDownloadTaskSnapshot[]> {
    const tasks = await this.downloads.listTasks();
    const existingIds = new Set(tasks.map((task) => task.id));
    for (const taskId of this.ownedTaskIds) {
      if (!existingIds.has(taskId)) this.ownedTaskIds.delete(taskId);
    }
    return tasks.filter((task) => this.ownedTaskIds.has(task.id)).map(toServerSnapshot);
  }

  /** 取消本组件创建的任务；其他下载业务的任务不会受到影响。 */
  async cancel(taskId: string): Promise<boolean> {
    if (!this.ownedTaskIds.has(taskId)) return false;
    return this.downloads.cancel(taskId);
  }

  /** 组件停止时只清理自身任务，公共下载组件仍可继续服务其他业务。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.ownedTaskIds].map((taskId) => this.downloads.cancel(taskId)));
    this.ownedTaskIds.clear();
  }
}

function parseStartRequest(value: unknown): StartServerCoreDownloadRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("server core source request must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    serverType: expectString(record.serverType, "serverType"),
    gameVersion: expectString(record.gameVersion, "gameVersion"),
    destinationDirectory: expectString(record.destinationDirectory, "destinationDirectory"),
    artifactFileName: expectFileName(record.artifactFileName, "artifactFileName"),
    destinationFileName: expectFileName(record.destinationFileName, "destinationFileName"),
    connections: expectConnections(record.connections),
  };
}

function selectArtifact(
  artifacts: readonly ServerCoreArtifact[],
  requestedFileName: string,
): ServerCoreArtifact {
  const artifact = artifacts.find((candidate) => candidate.fileName === requestedFileName);
  if (!artifact) throw new Error(`server core artifact is unavailable: ${requestedFileName}`);
  return artifact;
}

function appendCopyNumber(fileName: string, copyNumber: number): string {
  if (copyNumber === 0) return fileName;
  const extension = extname(fileName);
  return `${fileName.slice(0, -extension.length)}(${copyNumber})${extension}`;
}

function destinationKey(path: string): string {
  const normalizedPath = resolve(path);
  return usesCaseInsensitivePaths ? normalizedPath.toLowerCase() : normalizedPath;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 从公共任务的透明 metadata 恢复服务端核心业务快照。 */
function toServerSnapshot(task: DownloadTaskSnapshot): ServerCoreDownloadTaskSnapshot {
  const metadata = expectRecord(task.metadata, "server core source metadata");
  if (metadata.kind !== metadataKind)
    throw new Error("download task does not belong to server core source");
  const rawArtifact = expectRecord(metadata.artifact, "server core artifact metadata");
  const artifact: ServerCoreArtifact = {
    source: "cnb",
    serverType: expectString(rawArtifact.serverType, "metadata.artifact.serverType"),
    gameVersion: expectString(rawArtifact.gameVersion, "metadata.artifact.gameVersion"),
    fileName: expectString(rawArtifact.fileName, "metadata.artifact.fileName"),
    url: expectString(rawArtifact.url, "metadata.artifact.url"),
    sha256: expectString(rawArtifact.sha256, "metadata.artifact.sha256"),
  };
  if (rawArtifact.source !== "cnb" || artifact.url !== task.url) {
    throw new Error("server core source metadata does not match its task");
  }
  return {
    id: task.id,
    artifact,
    destinationPath: task.destinationPath,
    state: task.state,
    downloadedBytes: task.downloadedBytes,
    totalBytes: task.totalBytes,
    connections: task.connections,
    progress: task.progress,
    createdAt: task.createdAt,
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ...(task.error ? { error: task.error } : {}),
  };
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`server core source ${field} must be a non-empty string`);
  }
  return value;
}

function expectFileName(value: unknown, field: string): string {
  const fileName = expectString(value, field);
  if (
    fileName === "." ||
    fileName === ".." ||
    /[\\/]/u.test(fileName) ||
    basename(fileName) !== fileName ||
    !fileName.toLowerCase().endsWith(".jar")
  ) {
    throw new TypeError(`server core source ${field} must be a plain JAR file name`);
  }
  return fileName;
}

function expectConnections(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < serverDownloadConnectionLimits.minimum ||
    (value as number) > serverDownloadConnectionLimits.maximum
  ) {
    throw new TypeError(
      `server core source connections must be between ${serverDownloadConnectionLimits.minimum} and ${serverDownloadConnectionLimits.maximum}`,
    );
  }
  return value as number;
}
