import {
  serverDownloadConnectionLimits,
  supportsUnifiedWorldStorage,
  type ServerInstanceSnapshot,
  type ServerModDownloadResult,
  type ServerModDownloadableResourceType,
  type ServerModInstallRequest,
  type ServerModLoader,
  type ServerModSaveAsRequest,
} from "@seashard/contracts";
import type { DownloadService, DownloadTaskSnapshot } from "@seashard/download";
import {
  createShortRandomId,
  resolveWorldDatapackDirectory,
  resolveWorldStorageContainer,
  resolveWorldStorageRoot,
  type ServerInstanceManagerService,
} from "@seashard/server-instance-manager";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { extractWorldArchive } from "./world-storage";
import type { ServerModArtifact, ServerModCatalog } from "./catalog-types";
interface InstallRequest extends ServerModInstallRequest {
  readonly connections: number;
}

interface SaveRequest extends ServerModSaveAsRequest {
  readonly destinationDirectory: string;
  readonly connections: number;
}
const maximumWorldDirectoryAttempts = 8;

/**
 * 把 Modrinth 身份解析、实例兼容校验和公共下载任务串成一次受控安装。
 * Renderer 不能提供 URL、哈希或最终文件路径，目标只能来自已登记实例或系统目录选择框。
 */
export class ServerModDownloadCoordinator {
  constructor(
    private readonly catalog: ServerModCatalog,
    private readonly downloads: DownloadService,
    private readonly instances: ServerInstanceManagerService,
    private readonly worldIdFactory: () => string = createShortRandomId,
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
    if (request.resourceType === "world") {
      return this.downloadWorldToInstance(artifact, instance);
    }
    assertCompatibleInstance(artifact, instance);
    const datapackDirectory =
      request.resourceType === "datapack"
        ? await resolveWorldDatapackDirectory(instance, request.worldId)
        : undefined;
    const destinationDirectory =
      datapackDirectory?.absolutePath ??
      resolve(instance.rootPath, instance.serverType === "quilt" ? "server/mods" : "mods");
    const destinationPath = resolve(destinationDirectory, artifact.fileName);
    const task = await this.startAndWait(
      artifact,
      destinationDirectory,
      request.connections,
      instance.id,
      destinationPath,
    );
    await this.recordInstalledResource(
      instance,
      request.resourceType,
      artifact,
      destinationPath,
      datapackDirectory?.storageRoot,
    );
    return resultOf(artifact, task, "instance", instance.id);
  }

  /** 记录实际落盘相对路径；世界与数据包以统一世界根为索引基准。 */
  private async recordInstalledResource(
    instance: ServerInstanceSnapshot,
    resourceType: "mod" | "datapack" | "world",
    artifact: ServerModArtifact,
    absolutePath: string,
    relativeRootPath = instance.rootPath,
  ): Promise<void> {
    const relativePath = relative(relativeRootPath, absolutePath).replaceAll("\\", "/");
    await this.instances.recordResourceSource(instance.id, {
      resourceType,
      relativePath,
      source: artifact.source,
      id: artifact.projectId,
      ...(artifact.version ? { version: artifact.version } : {}),
      ...(artifact.iconUrl ? { iconUrl: artifact.iconUrl } : {}),
    });
  }
  /** 下载并解压到实例复用的 worlds-六位标识外层目录下，再创建 worlds-六位标识内层目录，不修改当前世界。 */
  private async downloadWorldToInstance(
    artifact: ServerModArtifact,
    instance: ServerInstanceSnapshot,
  ): Promise<ServerModDownloadResult> {
    if (!supportsUnifiedWorldStorage(instance.serverType)) {
      throw new Error("当前服务器核心不支持普通世界存档下载");
    }
    const preparedInstance = await this.instances.ensureWorldStorageDirectory(instance.id);
    const worldRoot = await resolveWorldStorageRoot(preparedInstance);
    const containerRoot = await resolveWorldStorageContainer(preparedInstance);
    await mkdir(containerRoot, { recursive: true });
    let destinationRoot: string | undefined;
    let destinationCreated = false;
    let stagingRoot: string | undefined;
    try {
      const archivePathRoot = resolve(worldRoot, ".seashard-world-");
      stagingRoot = await mkdtemp(archivePathRoot);
      const archivePath = join(stagingRoot, "world.zip");
      const extractedRoot = join(stagingRoot, "extracted");
      const task = await this.startAndWait(artifact, stagingRoot, 8, instance.id, archivePath);
      await extractWorldArchive(archivePath, extractedRoot);

      for (let attempt = 0; attempt < maximumWorldDirectoryAttempts; attempt += 1) {
        const candidate = resolve(containerRoot, `worlds-${this.worldIdFactory()}`);
        try {
          await rename(extractedRoot, candidate);
          destinationRoot = candidate;
          destinationCreated = true;
          break;
        } catch (error) {
          if (isAlreadyExistsError(error) || (await pathExists(candidate))) continue;
          throw error;
        }
      }
      if (!destinationRoot) throw new Error("世界存档目录生成冲突次数过多");
      await this.recordInstalledResource(
        preparedInstance,
        "world",
        artifact,
        destinationRoot,
        worldRoot,
      );
      return resultOf(artifact, task, "instance", instance.id);
    } catch (error) {
      if (destinationCreated && destinationRoot) {
        await rm(destinationRoot, { recursive: true, force: true });
      }
      throw error;
    } finally {
      if (stagingRoot) {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    }
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
    destinationPath?: string,
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
          destinationPath,
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
    destinationPath?: string,
  ): Promise<DownloadTaskSnapshot> {
    const task = await this.downloads.start({
      url,
      destinationPath: destinationPath ?? resolve(destinationDirectory, artifact.fileName),
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
  const resourceType = expectInstallableResourceType(record.resourceType);
  const worldId = record.worldId === undefined ? undefined : expectWorldId(record.worldId);
  if (resourceType === "datapack" && worldId === undefined) {
    throw new TypeError("数据包安装必须指定目标存档");
  }
  return {
    source: expectSource(record.source),
    resourceType,
    projectId: expectIdentity(record.projectId, "project ID"),
    versionId: expectIdentity(record.versionId, "version ID"),
    instanceId: expectIdentity(record.instanceId, "instance ID", 128),
    ...(worldId === undefined ? {} : { worldId }),
    connections: expectConnections(
      record.connections ?? serverDownloadConnectionLimits.defaultValue,
    ),
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

function expectInstallableResourceType(value: unknown): "mod" | "datapack" | "world" {
  if (value !== "mod" && value !== "datapack" && value !== "world") {
    throw new TypeError("server resource type must be mod, datapack, or world");
  }
  return value;
}

function expectDownloadableResourceType(value: unknown): ServerModDownloadableResourceType {
  if (value !== "mod" && value !== "modpack" && value !== "datapack" && value !== "world") {
    throw new TypeError("server resource type is invalid");
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

function expectWorldId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1_024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError("server world ID is invalid");
  }
  return value;
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

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
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
