import {
  serverDownloadConnectionLimits,
  serverCoreIconHost,
  serverCoreIconScheme,
  serverModLoaderForCoreType,
  type ServerCoreManagedDownloadResult,
  type ServerInstanceContentCounts,
  type ServerInstanceSnapshot,
} from "@seashard/contracts";
import type { ServerCoreSourceService } from "@seashard/server-core-source";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import {
  portableInstanceMetadataDirectoryName,
  readPortableInstanceManifests,
  writePortableInstanceManifests,
  writePortableSeaShardInstanceManifest,
} from "./manifest";
import { instanceNameKey, type SQLiteServerInstanceRegistry } from "./registry";
import type { CreateManagedServerInstanceRequest } from "./types";
import { parseServerInstanceStartupSettings } from "./startup-settings";

interface PendingManagedInstance {
  readonly id: string;
  readonly name: string;
  readonly nameKey: string;
  readonly rootPath: string;
  readonly createdAt: string;
}

export interface ServerInstanceManagerOptions {
  readonly managedRoot: string;
  readonly registry: SQLiteServerInstanceRegistry;
  readonly coreSource: ServerCoreSourceService;
  readonly createId?: () => string;
  readonly now?: () => string;
  readonly reportError?: (error: unknown) => void;
}

/** 协调托管目录、核心下载、双 JSON 描述文件和 SQLite 路径索引的提交顺序。 */
export class ServerInstanceManager {
  private readonly managedRoot: string;
  private readonly reservedNameKeys = new Set<string>();
  private readonly pending = new Map<string, PendingManagedInstance>();
  private readonly finalizers = new Map<string, Promise<void>>();
  private readonly deletions = new Map<string, Promise<void>>();
  private readonly metadataUpdates = new Map<string, Promise<ServerInstanceSnapshot>>();
  private disposed = false;
  private iconBackfillTask: Promise<void> | undefined;

  constructor(private readonly options: ServerInstanceManagerOptions) {
    if (!isAbsolute(options.managedRoot)) {
      throw new TypeError("server instance managed root must be absolute");
    }
    this.managedRoot = resolve(options.managedRoot);
  }

  async list(): Promise<readonly ServerInstanceSnapshot[]> {
    const instances = await this.readIndexedInstances();
    if (
      !instances.some(
        (instance) =>
          !instance.iconPath &&
          instance.storageMode === "managed" &&
          instance.source === "downloaded" &&
          instance.serverType,
      )
    ) {
      return instances;
    }

    const task = this.iconBackfillTask ?? this.backfillMissingIcons(instances);
    this.iconBackfillTask = task;
    try {
      await task;
    } finally {
      if (this.iconBackfillTask === task) this.iconBackfillTask = undefined;
    }
    return this.readIndexedInstances();
  }
  /** 实例启动设置整体持久化；未设置的旧实例仍继续继承全局默认值。 */
  async setStartupSettings(
    instanceValue: unknown,
    settingsValue: unknown,
  ): Promise<ServerInstanceSnapshot> {
    if (this.disposed) throw new Error("server instance manager is stopped");
    const instanceId = expectDirectoryName(instanceValue, "instance id");
    const startupSettings = parseServerInstanceStartupSettings(settingsValue);
    return this.updatePrivateManifest(instanceId, (instance) => ({
      ...instance,
      startupSettings,
      updatedAt: this.options.now?.() ?? new Date().toISOString(),
    }));
  }

  /** 只更新 SeaShard 私有清单；服务端核心与 Minecraft 版本等事实保持不变。 */
  async recordStartedAt(instanceValue: unknown, startedAtValue: unknown): Promise<void> {
    if (this.disposed) throw new Error("server instance manager is stopped");
    const instanceId = expectDirectoryName(instanceValue, "instance id");
    const startedAt = expectIsoTimestamp(startedAtValue, "startedAt");
    await this.updatePrivateManifest(instanceId, (instance) => ({
      ...instance,
      lastStartedAt: startedAt,
      updatedAt: startedAt,
    }));
  }

  /** 串行读取最新私有清单并累加本次会话，避免与启动时间写入互相覆盖。 */
  async recordRuntime(
    instanceValue: unknown,
    startedAtValue: unknown,
    stoppedAtValue: unknown,
  ): Promise<void> {
    if (this.disposed) throw new Error("server instance manager is stopped");
    const instanceId = expectDirectoryName(instanceValue, "instance id");
    const startedAt = expectIsoTimestamp(startedAtValue, "startedAt");
    const stoppedAt = expectIsoTimestamp(stoppedAtValue, "stoppedAt");
    const elapsedMs = Date.parse(stoppedAt) - Date.parse(startedAt);
    if (elapsedMs < 0) {
      throw new TypeError("managed server instance stoppedAt must not precede startedAt");
    }
    await this.updatePrivateManifest(instanceId, (instance) => {
      const totalRuntimeMs = (instance.totalRuntimeMs ?? 0) + elapsedMs;
      if (!Number.isSafeInteger(totalRuntimeMs)) {
        throw new RangeError(
          "managed server instance total runtime exceeds the safe integer range",
        );
      }
      return {
        ...instance,
        totalRuntimeMs,
        updatedAt: stoppedAt,
      };
    });
  }

  /** 删除仅限由 SeaShard 管理且仍位于 managedRoot 直属目录中的实例。 */
  async delete(value: unknown): Promise<void> {
    if (this.disposed) throw new Error("server instance manager is stopped");
    const instanceId = expectDirectoryName(value, "instance id");
    if ([...this.pending.values()].some((pending) => pending.id === instanceId)) {
      throw new Error(`server instance ${instanceId} is still downloading`);
    }
    if (this.deletions.has(instanceId)) {
      throw new Error(`server instance ${instanceId} is already being deleted`);
    }

    const task = this.deleteManagedInstance(instanceId);
    this.deletions.set(instanceId, task);
    try {
      await task;
    } finally {
      if (this.deletions.get(instanceId) === task) this.deletions.delete(instanceId);
    }
  }

  /**
   * 为下载预留唯一实例名和独立目录。
   * 下载任务先返回给 UI；哈希校验完成后，后台再原子写两个描述文件并登记 SQLite。
   */
  async createManaged(value: unknown): Promise<ServerCoreManagedDownloadResult> {
    if (this.disposed) throw new Error("server instance manager is stopped");
    const request = parseCreateManagedRequest(value);
    const reservation = await this.reserveName(request.gameVersion, request.serverType);
    const id = expectDirectoryName(this.options.createId?.() ?? randomUUID(), "instance id");
    const rootPath = resolve(this.managedRoot, id);
    const createdAt = this.options.now?.() ?? new Date().toISOString();
    const pending: PendingManagedInstance = {
      id,
      name: reservation.name,
      nameKey: reservation.key,
      rootPath,
      createdAt,
    };

    try {
      await mkdir(this.managedRoot, { recursive: true });
      await mkdir(rootPath, { recursive: false });
      if (this.disposed) throw new Error("server instance manager is stopped");
      const task = await this.options.coreSource.start({
        ...request,
        destinationDirectory: rootPath,
      });
      if (this.disposed) {
        await this.options.coreSource.cancel(task.id);
        throw new Error("server instance manager is stopped");
      }
      this.pending.set(task.id, pending);
      const finalizer = this.finalizeManagedDownload(task.id, pending);
      this.finalizers.set(task.id, finalizer);
      void finalizer.catch((error) => this.options.reportError?.(error));
      return { instanceId: id, task };
    } catch (error) {
      this.reservedNameKeys.delete(reservation.key);
      await rm(rootPath, { recursive: true, force: true });
      throw error;
    }
  }

  /** 测试与宿主停机可等待单个托管任务的登记或清理结束。 */
  async waitForManagedTask(taskId: string): Promise<void> {
    await this.finalizers.get(taskId);
  }

  /** 受限协议只通过 JSON 中的实例 ID 解析实例自己的图标路径。 */
  async resolveIconPath(value: unknown): Promise<string | null> {
    const instanceId = expectDirectoryName(value, "instance id");
    const instance = (await this.readIndexedInstances()).find(({ id }) => id === instanceId);
    if (!instance?.iconPath) return null;
    try {
      await access(instance.iconPath);
      return instance.iconPath;
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
  }

  /** 只扫描已登记实例的标准内容目录；缺失目录按空目录处理。 */
  async contentCounts(value: unknown): Promise<ServerInstanceContentCounts> {
    const instanceId = expectDirectoryName(value, "instance id");
    const { instance } = await this.findIndexedInstance(instanceId);
    const [rootMods, serverMods, plugins] = await Promise.all([
      countJarFiles(resolve(instance.rootPath, "mods")),
      countJarFiles(resolve(instance.rootPath, "server", "mods")),
      countJarFiles(resolve(instance.rootPath, "plugins")),
    ]);
    return {
      mods: rootMods + serverMods,
      plugins,
    };
  }

  /** 停机时取消尚未完成的托管下载，等待目录清理后再卸载依赖组件。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all(
      [...this.pending.keys()].map((taskId) => this.options.coreSource.cancel(taskId)),
    );
    await Promise.allSettled(this.finalizers.values());
    await Promise.allSettled(this.deletions.values());
    await Promise.allSettled(this.metadataUpdates.values());
  }

  /** 同一实例的私有清单更新必须串行，后一项始终基于前一项的落盘结果。 */
  private async updatePrivateManifest(
    instanceId: string,
    update: (instance: ServerInstanceSnapshot) => ServerInstanceSnapshot,
  ): Promise<ServerInstanceSnapshot> {
    const previous = this.metadataUpdates.get(instanceId);
    const task = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(async () => {
      const { instance } = await this.findIndexedInstance(instanceId);
      const updated = update(instance);
      await writePortableSeaShardInstanceManifest(updated);
      return updated;
    });
    this.metadataUpdates.set(instanceId, task);
    try {
      return await task;
    } finally {
      if (this.metadataUpdates.get(instanceId) === task) {
        this.metadataUpdates.delete(instanceId);
      }
    }
  }

  /**
   * 先移除 SQLite 索引，再直接递归删除实例目录。
   * Windows 上的短暂文件占用由 rm 重试处理；目录删除失败时恢复索引，避免实例悄然丢失。
   */
  private async deleteManagedInstance(instanceId: string): Promise<void> {
    const { instance, manifestPath } = await this.findIndexedInstance(instanceId);
    if (instance.storageMode !== "managed") {
      throw new Error(`server instance ${instanceId} is not managed by SeaShard`);
    }
    const rootPath = resolve(instance.rootPath);
    if (rootPath !== resolve(this.managedRoot, instance.id)) {
      throw new Error(`server instance ${instanceId} directory is outside the managed root`);
    }

    const nameKey = instanceNameKey(instance.name);
    this.reservedNameKeys.add(nameKey);
    let registryDeleted = false;
    try {
      await this.options.registry.deleteManifestPath(manifestPath);
      registryDeleted = true;
      await rm(rootPath, {
        recursive: true,
        force: false,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch (error) {
      if (registryDeleted) {
        try {
          await this.options.registry.insertManifestPath(manifestPath);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `server instance ${instanceId} deletion and registry rollback both failed`,
          );
        }
      }
      throw error;
    } finally {
      this.reservedNameKeys.delete(nameKey);
    }
  }

  private async findIndexedInstance(
    instanceId: string,
  ): Promise<{ instance: ServerInstanceSnapshot; manifestPath: string }> {
    for (const manifestPath of await this.options.registry.listManifestPaths()) {
      try {
        const instance = await readPortableInstanceManifests(manifestPath);
        if (instance.id === instanceId) return { instance, manifestPath };
      } catch (error) {
        this.options.reportError?.(error);
      }
    }
    throw new Error(`server instance ${instanceId} was not found`);
  }

  private async reserveName(
    gameVersion: string,
    serverType: string,
  ): Promise<{ name: string; key: string }> {
    const baseName = `${normalizeInstanceNamePart(gameVersion)}-${normalizeInstanceNamePart(serverType)}`;
    const existingKeys = new Set(
      (await this.readIndexedInstances()).map(({ name }) => instanceNameKey(name)),
    );
    for (let copyNumber = 0; ; copyNumber += 1) {
      const name = copyNumber === 0 ? baseName : `${baseName}(${copyNumber})`;
      const key = instanceNameKey(name);
      if (existingKeys.has(key) || this.reservedNameKeys.has(key)) continue;
      this.reservedNameKeys.add(key);
      return { name, key };
    }
  }

  private async finalizeManagedDownload(
    taskId: string,
    pending: PendingManagedInstance,
  ): Promise<void> {
    try {
      const task = await this.options.coreSource.wait(taskId);
      if (!task || task.state !== "completed") {
        await rm(pending.rootPath, { recursive: true, force: true });
        return;
      }

      const iconPath = await this.inheritCoreIcon(task.artifact.serverType, pending.rootPath);
      const updatedAt = this.options.now?.() ?? new Date().toISOString();
      const instance: ServerInstanceSnapshot = {
        id: pending.id,
        name: pending.name,
        rootPath: pending.rootPath,
        coreJarPath: task.destinationPath,
        ...(iconPath ? { iconPath } : {}),
        storageMode: "managed",
        source: "downloaded",
        modLoader: serverModLoaderForCoreType(task.artifact.serverType),
        serverType: task.artifact.serverType,
        gameVersion: task.artifact.gameVersion,
        coreArtifactFileName: task.artifact.fileName,
        artifactSha256: task.artifact.sha256,
        createdAt: pending.createdAt,
        updatedAt,
      };
      const manifestPath = await writePortableInstanceManifests(instance);
      await this.options.registry.insertManifestPath(manifestPath);
    } catch (error) {
      await rm(pending.rootPath, { recursive: true, force: true });
      throw error;
    } finally {
      this.pending.delete(taskId);
      this.finalizers.delete(taskId);
      this.reservedNameKeys.delete(pending.nameKey);
    }
  }

  /** 核心图标缓存已经过哈希校验；复制进实例目录后即可随实例整体移动。 */
  private async inheritCoreIcon(serverType: string, rootPath: string): Promise<string | undefined> {
    const type = (await this.options.coreSource.listTypes()).find(({ id }) => id === serverType);
    if (!type?.iconUrl) return undefined;

    let url: URL;
    try {
      url = new URL(type.iconUrl);
    } catch {
      return undefined;
    }
    if (
      url.protocol !== `${serverCoreIconScheme}:` ||
      url.hostname !== serverCoreIconHost ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    const sha256 = /^\/([a-f0-9]{64})$/u.exec(url.pathname)?.[1];
    if (!sha256) return undefined;
    const sourcePath = await this.options.coreSource.resolveIconPath(sha256);
    if (!sourcePath) return undefined;

    const iconDirectory = resolve(rootPath, portableInstanceMetadataDirectoryName);
    const destinationPath = resolve(iconDirectory, "icon.png");
    await mkdir(iconDirectory, { recursive: true });
    await copyFile(sourcePath, destinationPath);
    return destinationPath;
  }

  /** 旧实例首次读取时补齐核心图标；该变化只回写 seashard.json。 */
  private async backfillMissingIcons(instances: readonly ServerInstanceSnapshot[]): Promise<void> {
    for (const instance of instances) {
      if (
        instance.iconPath ||
        instance.storageMode !== "managed" ||
        instance.source !== "downloaded" ||
        !instance.serverType
      ) {
        continue;
      }
      try {
        const iconPath = await this.inheritCoreIcon(instance.serverType, instance.rootPath);
        if (!iconPath) continue;
        const updatedAt = this.options.now?.() ?? new Date().toISOString();
        await writePortableSeaShardInstanceManifest({ ...instance, iconPath, updatedAt });
      } catch (error) {
        this.options.reportError?.(error);
      }
    }
  }

  /** 逐个读取索引指向的双 JSON；单个损坏或丢失的实例不能拖垮整个列表。 */
  private async readIndexedInstances(): Promise<readonly ServerInstanceSnapshot[]> {
    const instances: ServerInstanceSnapshot[] = [];
    for (const manifestPath of await this.options.registry.listManifestPaths()) {
      try {
        instances.push(await readPortableInstanceManifests(manifestPath));
      } catch (error) {
        this.options.reportError?.(error);
      }
    }
    return instances.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    );
  }
}

/** 用户可读实例名只把空白折叠为下划线；重复后缀由实例管理器分配。 */
export function normalizeInstanceNamePart(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, "_");
  if (!normalized) throw new TypeError("server instance name part must not be empty");
  return normalized;
}

/** 标准内容目录只统计直接放置的 JAR；配置文件、子目录和禁用文件不计入数量。 */
async function countJarFiles(directory: string): Promise<number> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jar"))
      .length;
  } catch (error) {
    if (isMissingPathError(error)) return 0;
    throw error;
  }
}

function parseCreateManagedRequest(value: unknown): CreateManagedServerInstanceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("managed server instance request must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    serverType: expectString(record.serverType, "serverType"),
    gameVersion: expectString(record.gameVersion, "gameVersion"),
    artifactFileName: expectJarFileName(record.artifactFileName, "artifactFileName"),
    destinationFileName: expectJarFileName(record.destinationFileName, "destinationFileName"),
    connections: expectConnections(record.connections),
  };
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`managed server instance ${field} must be a non-empty string`);
  }
  return value;
}

function expectIsoTimestamp(value: unknown, field: string): string {
  const timestamp = expectString(value, field);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new TypeError(`managed server instance ${field} must be an ISO timestamp`);
  }
  return timestamp;
}
function expectDirectoryName(value: unknown, field: string): string {
  const name = expectString(value, field);
  if (name === "." || name === ".." || /[\\/]/u.test(name) || basename(name) !== name) {
    throw new TypeError(`managed server instance ${field} must be a plain directory name`);
  }
  return name;
}

function expectJarFileName(value: unknown, field: string): string {
  const fileName = expectString(value, field);
  if (
    fileName === "." ||
    fileName === ".." ||
    /[\\/]/u.test(fileName) ||
    basename(fileName) !== fileName ||
    !fileName.toLowerCase().endsWith(".jar")
  ) {
    throw new TypeError(`managed server instance ${field} must be a plain JAR file name`);
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
      `managed server instance connections must be between ${serverDownloadConnectionLimits.minimum} and ${serverDownloadConnectionLimits.maximum}`,
    );
  }
  return value as number;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    Reflect.get(error, "code") === "ENOENT"
  );
}
