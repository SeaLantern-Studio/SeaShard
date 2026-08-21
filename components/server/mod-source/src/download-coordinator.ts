import { isAbsolute, resolve } from "node:path";
import {
  serverDownloadConnectionLimits,
  type ServerInstanceSnapshot,
  type ServerModDownloadResult,
  type ServerModInstallRequest,
  type ServerModLoader,
  type ServerModSaveAsRequest,
} from "@seashard/contracts";
import type { DownloadService, DownloadTaskSnapshot } from "@seashard/download";
import type { ServerInstanceManagerService } from "@seashard/server-instance-manager";
import type { ServerModArtifact, ServerModCatalog } from "./catalog-types";

interface InstallRequest extends ServerModInstallRequest {
  readonly connections: number;
}

interface SaveRequest extends ServerModSaveAsRequest {
  readonly destinationDirectory: string;
  readonly connections: number;
}

/**
 * 把 Modrinth 身份解析、实例兼容校验和公共下载任务串成一次受控安装。
 * Renderer 不能提供 URL、哈希或最终文件路径，目标只能来自已登记实例或系统目录选择框。
 */
export class ServerModDownloadCoordinator {
  constructor(
    private readonly catalog: ServerModCatalog,
    private readonly downloads: DownloadService,
    private readonly instances: ServerInstanceManagerService,
  ) {}

  async installToInstance(value: unknown): Promise<ServerModDownloadResult> {
    const request = parseInstallRequest(value);
    const instance = (await this.instances.list()).find(({ id }) => id === request.instanceId);
    if (!instance) throw new Error(`找不到服务器实例：${request.instanceId}`);

    const artifact = await this.catalog.resolveVersionArtifact(
      request.resourceType,
      request.source,
      request.projectId,
      request.versionId,
    );
    assertCompatibleInstance(artifact, instance);
    const destinationDirectory =
      artifact.resourceType === "datapack"
        ? resolve(instance.rootPath, "world", "datapacks")
        : resolve(instance.rootPath, instance.serverType === "quilt" ? "server/mods" : "mods");
    const task = await this.startAndWait(
      artifact,
      destinationDirectory,
      request.connections,
      instance.id,
    );
    return resultOf(artifact, task, "instance", instance.id);
  }

  async saveToDirectory(value: unknown): Promise<ServerModDownloadResult> {
    const request = parseSaveRequest(value);
    const artifact = await this.catalog.resolveVersionArtifact(
      request.resourceType,
      request.source,
      request.projectId,
      request.versionId,
    );
    const task = await this.startAndWait(
      artifact,
      request.destinationDirectory,
      request.connections,
    );
    return resultOf(artifact, task, "directory");
  }

  private async startAndWait(
    artifact: ServerModArtifact,
    destinationDirectory: string,
    connections: number,
    instanceId?: string,
  ): Promise<DownloadTaskSnapshot> {
    const urls = [artifact.url, artifact.fallbackUrl].filter((url): url is string => Boolean(url));
    let lastError: unknown;
    for (const url of urls) {
      try {
        return await this.startAndWaitFromUrl(
          artifact,
          url,
          destinationDirectory,
          connections,
          instanceId,
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("服务器资源下载失败");
  }

  private async startAndWaitFromUrl(
    artifact: ServerModArtifact,
    url: string,
    destinationDirectory: string,
    connections: number,
    instanceId?: string,
  ): Promise<DownloadTaskSnapshot> {
    const task = await this.downloads.start({
      url,
      destinationPath: resolve(destinationDirectory, artifact.fileName),
      expectedBytes: artifact.size,
      ...(artifact.sha1 ? { sha1: artifact.sha1 } : {}),
      ...(artifact.sha512 ? { sha512: artifact.sha512 } : {}),
      connections,
      metadata: {
        kind: `server-${artifact.resourceType}`,
        userVisible: true,
        resourceType: artifact.resourceType,
        projectId: artifact.projectId,
        versionId: artifact.versionId,
        fileName: artifact.fileName,
        ...(instanceId ? { instanceId } : {}),
      },
    });
    const completed = await this.downloads.wait(task.id);
    if (!completed) throw new Error("服务器资源下载任务未找到");
    if (completed.state !== "completed") {
      throw new Error(
        completed.error ? `服务器资源下载失败：${completed.error}` : "服务器资源下载未完成",
      );
    }
    return completed;
  }
}

function assertCompatibleInstance(
  artifact: ServerModArtifact,
  instance: ServerInstanceSnapshot,
): void {
  if (!instance.gameVersion || !artifact.gameVersions.includes(instance.gameVersion)) {
    throw new Error(`该资源版本不支持实例 ${instance.name} 的 Minecraft 版本`);
  }
  if (artifact.resourceType === "datapack") return;
  if (!instance.modLoader) {
    throw new Error(`服务器实例 ${instance.name} 不支持安装 Mod`);
  }
  if (!artifact.loaders.includes(instance.modLoader)) {
    throw new Error(`该 Mod 版本不支持 ${formatLoader(instance.modLoader)} 实例 ${instance.name}`);
  }
}

function parseInstallRequest(value: unknown): InstallRequest {
  const record = expectRecord(value, "server resource install request");
  return {
    source: expectSource(record.source),
    resourceType: expectDownloadableResourceType(record.resourceType),
    projectId: expectIdentity(record.projectId, "project ID"),
    versionId: expectIdentity(record.versionId, "version ID"),
    instanceId: expectIdentity(record.instanceId, "instance ID", 128),
    connections: expectConnections(record.connections),
  };
}

function parseSaveRequest(value: unknown): SaveRequest {
  const record = expectRecord(value, "server resource save request");
  const destinationDirectory = expectString(record.destinationDirectory, "destination directory");
  if (!isAbsolute(destinationDirectory)) {
    throw new TypeError("server resource destination directory must be absolute");
  }
  return {
    source: expectSource(record.source),
    resourceType: expectDownloadableResourceType(record.resourceType),
    projectId: expectIdentity(record.projectId, "project ID"),
    versionId: expectIdentity(record.versionId, "version ID"),
    destinationDirectory: resolve(destinationDirectory),
    connections: expectConnections(record.connections),
  };
}

function expectSource(value: unknown): "modrinth" | "curseforge" {
  if (value !== "modrinth" && value !== "curseforge") {
    throw new TypeError("server resource source is invalid");
  }
  return value;
}

function expectDownloadableResourceType(value: unknown): "mod" | "datapack" {
  if (value === "modpack") {
    throw new TypeError("server modpack download is not available");
  }
  if (value !== "mod" && value !== "datapack") {
    throw new TypeError("server resource type must be mod or datapack");
  }
  return value;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new TypeError(`server mod ${label} must be a non-empty string`);
  }
  return value;
}

function expectIdentity(value: unknown, label: string, maximumLength = 64): string {
  const identity = expectString(value, label).trim();
  if (identity.length > maximumLength || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(identity)) {
    throw new TypeError(`server mod ${label} is invalid`);
  }
  return identity;
}

function expectConnections(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < serverDownloadConnectionLimits.minimum ||
    (value as number) > serverDownloadConnectionLimits.maximum
  ) {
    throw new TypeError("server mod connections are invalid");
  }
  return value as number;
}

function formatLoader(loader: ServerModLoader): string {
  if (loader === "neoforge") return "NeoForge";
  return `${loader.charAt(0).toUpperCase()}${loader.slice(1)}`;
}

function resultOf(
  artifact: ServerModArtifact,
  task: DownloadTaskSnapshot,
  destination: ServerModDownloadResult["destination"],
  instanceId?: string,
): ServerModDownloadResult {
  return {
    source: artifact.source,
    resourceType: artifact.resourceType,
    projectId: artifact.projectId,
    versionId: artifact.versionId,
    fileName: artifact.fileName,
    destination,
    ...(instanceId ? { instanceId } : {}),
    downloadedBytes: task.downloadedBytes,
  };
}
