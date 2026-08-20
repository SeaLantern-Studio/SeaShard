import type {
  ServerConfigurationCatalog,
  ServerConfigurationDocument,
  ServerConfigurationFile,
  ServerConfigurationFileKind,
  ServerConfigurationWriteRequest,
  ServerInstanceSnapshot,
} from "@seashard/contracts";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

const maximumConfigurationBytes = 1_000_000;
const maximumPluginConfigurationFiles = 500;
const maximumPluginDirectoryDepth = 8;

const configurationRootSubdirectories: Readonly<Record<string, string>> = {
  quilt: "server",
};

/** server.properties 是 Minecraft 服务端的主配置；其余核心附属文件进入“其他配置”。 */
const serverConfigurationPaths = ["server.properties"] as const;

const otherConfigurationPaths = [
  "bukkit.yml",
  "spigot.yml",
  "paper.yml",
  "purpur.yml",
  "pufferfish.yml",
  "commands.yml",
  "help.yml",
  "permissions.yml",
  "wepif.yml",
  "config.yml",
  "velocity.toml",
  "waterfall.yml",
  "config/paper-global.yml",
  "config/paper-world-defaults.yml",
] as const;

const pluginConfigurationExtensions = new Set([
  ".yml",
  ".yaml",
  ".json",
  ".properties",
  ".conf",
  ".toml",
  ".txt",
]);

/** 这些核心提供 Bukkit、Sponge、Nukkit 或代理插件接口；已有 plugins 目录也会独立启用插件页。 */
export const pluginCapableServerTypes: ReadonlySet<string> = new Set([
  "arclight-fabric",
  "arclight-forge",
  "arclight-neoforge",
  "banner",
  "bukkit",
  "bungeecord",
  "catserver",
  "folia",
  "leaf",
  "leaves",
  "lightfall",
  "mohist",
  "nukkitx",
  "paper",
  "pufferfish",
  "pufferfish_purpur",
  "purpur",
  "spigot",
  "spongeforge",
  "spongevanilla",
  "travertine",
  "velocity",
  "youer",
]);

export interface ServerConfigurationDirectoryEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface ServerConfigurationFileStat {
  readonly size: number;
  readonly mtime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface ServerConfigurationFileSystem {
  readdir(path: string): Promise<readonly ServerConfigurationDirectoryEntry[]>;
  stat(path: string): Promise<ServerConfigurationFileStat>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
}

const nodeFileSystem: ServerConfigurationFileSystem = {
  readdir: async (path) => readdir(path, { withFileTypes: true }) as Promise<Dirent[]>,
  stat: async (path) => stat(path) as Promise<Stats>,
  realpath,
  readFile,
  writeFile,
  mkdir: async (path) => mkdir(path, { recursive: true }).then(() => undefined),
  copyFile,
};

export interface ServerConfigurationManagerOptions {
  readonly listInstances: () => Promise<readonly ServerInstanceSnapshot[]>;
  readonly fileSystem?: ServerConfigurationFileSystem;
  readonly now?: () => Date;
}

/**
 * 列出并修改实例内的文本配置。
 * 所有读写都会重新解析实例和文件目录；Renderer 缓存的旧路径不能绕过当前文件系统边界。
 */
export class ServerConfigurationManager {
  private readonly fileSystem: ServerConfigurationFileSystem;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ServerConfigurationManagerOptions) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
  }

  async list(value: unknown): Promise<ServerConfigurationCatalog> {
    const instanceId = expectNonEmptyString(value, "服务器实例 ID");
    const instance = await this.resolveInstance(instanceId);
    const rootPath = await this.resolveConfigurationRoot(instance);
    const serverFiles: ServerConfigurationFile[] = [];
    const otherFiles: ServerConfigurationFile[] = [];

    for (const path of serverConfigurationPaths) {
      const descriptor = await this.describeExistingFile(rootPath, path, "server");
      if (descriptor) serverFiles.push(descriptor);
    }
    for (const path of otherConfigurationPaths) {
      const descriptor = await this.describeExistingFile(rootPath, path, "other");
      if (descriptor) otherFiles.push(descriptor);
    }

    const pluginsRoot = resolve(rootPath, "plugins");
    const hasPluginsDirectory = await this.isSafeDirectory(rootPath, pluginsRoot);
    const plugins = hasPluginsDirectory
      ? await this.scanPluginConfigurations(rootPath, pluginsRoot)
      : [];

    return {
      instanceId,
      configurationRootPath: rootPath,
      ...(instance.serverType ? { serverType: instance.serverType } : {}),
      pluginSupported:
        hasPluginsDirectory ||
        (instance.serverType !== undefined && pluginCapableServerTypes.has(instance.serverType)),
      serverFiles,
      otherFiles,
      plugins,
    };
  }

  async read(instanceValue: unknown, pathValue: unknown): Promise<ServerConfigurationDocument> {
    const instanceId = expectNonEmptyString(instanceValue, "服务器实例 ID");
    const path = expectRelativeConfigurationPath(pathValue);
    const descriptor = await this.resolveListedDescriptor(instanceId, path);
    const instance = await this.resolveInstance(instanceId);
    const rootPath = await this.resolveConfigurationRoot(instance);
    const filePath = await this.resolveSafeExistingFile(rootPath, path);
    return this.readDocument(instanceId, descriptor, filePath);
  }

  write(value: unknown): Promise<ServerConfigurationDocument> {
    const request = parseWriteRequest(value);
    const task = this.writeQueue.then(() => this.writeNow(request));
    this.writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async writeNow(
    request: ServerConfigurationWriteRequest,
  ): Promise<ServerConfigurationDocument> {
    const descriptor = await this.resolveListedDescriptor(request.instanceId, request.path);
    const instance = await this.resolveInstance(request.instanceId);
    const rootPath = await this.resolveConfigurationRoot(instance);
    const filePath = await this.resolveSafeExistingFile(rootPath, request.path);
    const current = await this.readDocument(request.instanceId, descriptor, filePath);
    if (current.revision !== request.expectedRevision) {
      throw new Error("配置文件已被服务器或其他编辑器修改，请重新载入后再保存。");
    }

    const contentBytes = new TextEncoder().encode(request.content);
    const bomBytes = current.encoding === "utf-8-bom" ? 3 : 0;
    if (contentBytes.byteLength + bomBytes > maximumConfigurationBytes) {
      throw new RangeError("配置文件不能超过 1 MB。");
    }

    const backupDirectory = resolve(rootPath, ".seashard", "backups", "configuration");
    await this.fileSystem.mkdir(backupDirectory);
    const timestamp = (this.options.now?.() ?? new Date()).toISOString().replace(/[:.]/gu, "-");
    const backupName = `${safeBackupName(request.path)}.${timestamp}-${randomUUID()}.${current.revision.slice(0, 12)}.bak`;
    await this.fileSystem.copyFile(filePath, resolve(backupDirectory, backupName));

    let output = contentBytes;
    if (current.encoding === "utf-8-bom") {
      output = new Uint8Array(contentBytes.byteLength + 3);
      output.set([0xef, 0xbb, 0xbf]);
      output.set(contentBytes, 3);
    }
    await this.fileSystem.writeFile(filePath, output);
    return this.readDocument(request.instanceId, descriptor, filePath);
  }

  private async resolveListedDescriptor(
    instanceId: string,
    path: string,
  ): Promise<ServerConfigurationFile> {
    const catalog = await this.list(instanceId);
    const files = [
      ...catalog.serverFiles,
      ...catalog.otherFiles,
      ...catalog.plugins.flatMap((plugin) => plugin.files),
    ];
    const descriptor = files.find((file) => file.path === path);
    if (!descriptor) throw new Error("配置文件不在当前实例的可编辑目录中。");
    return descriptor;
  }

  private async resolveInstance(instanceId: string): Promise<ServerInstanceSnapshot> {
    const instance = (await this.options.listInstances()).find(
      (candidate) => candidate.id === instanceId,
    );
    if (!instance) throw new Error(`找不到服务器实例：${instanceId}`);
    if (!isAbsolute(instance.rootPath)) throw new Error("服务器实例根目录不是绝对路径。");
    return instance;
  }

  /**
   * 配置目录默认等于实例根目录；安装到子目录的核心在这里集中声明。
   * realpath 与实例边界校验阻止子目录被符号链接重定向到实例之外。
   */
  private async resolveConfigurationRoot(instance: ServerInstanceSnapshot): Promise<string> {
    const instanceRoot = await this.fileSystem.realpath(instance.rootPath);
    const subdirectory = instance.serverType
      ? configurationRootSubdirectories[instance.serverType]
      : undefined;
    if (!subdirectory) return instanceRoot;
    const configurationRoot = await this.fileSystem.realpath(resolve(instanceRoot, subdirectory));
    if (!isWithinRoot(instanceRoot, configurationRoot)) {
      throw new Error("服务器配置根目录超出实例目录。");
    }
    return configurationRoot;
  }

  private async scanPluginConfigurations(
    rootPath: string,
    pluginsRoot: string,
  ): Promise<ServerConfigurationCatalog["plugins"]> {
    const groups = new Map<string, ServerConfigurationFile[]>();
    let fileCount = 0;

    const visit = async (
      directory: string,
      relativeDirectory: string,
      depth: number,
    ): Promise<void> => {
      if (depth > maximumPluginDirectoryDepth || fileCount >= maximumPluginConfigurationFiles)
        return;
      const entries = [...(await this.fileSystem.readdir(directory))].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      for (const entry of entries) {
        if (fileCount >= maximumPluginConfigurationFiles) break;
        if (entry.isSymbolicLink() || entry.name === "." || entry.name === "..") continue;
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const absolutePath = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          if (await this.isSafeDirectory(rootPath, absolutePath)) {
            await visit(absolutePath, relativePath, depth + 1);
          }
          continue;
        }
        if (
          !entry.isFile() ||
          !pluginConfigurationExtensions.has(extname(entry.name).toLowerCase())
        ) {
          continue;
        }
        const listedPath = `plugins/${relativePath}`;
        const descriptor = await this.describeExistingFile(rootPath, listedPath, "plugin");
        if (!descriptor) continue;
        const pluginName = relativePath.includes("/")
          ? relativePath.slice(0, relativePath.indexOf("/"))
          : "通用配置";
        const groupFiles = groups.get(pluginName) ?? [];
        groupFiles.push({ ...descriptor, pluginName });
        groups.set(pluginName, groupFiles);
        fileCount += 1;
      }
    };

    await visit(pluginsRoot, "", 0);
    return [...groups.entries()]
      .sort(([left], [right]) => {
        if (left === "通用配置") return 1;
        if (right === "通用配置") return -1;
        return left.localeCompare(right);
      })
      .map(([name, files]) => ({
        name,
        files: files.sort((left, right) => left.path.localeCompare(right.path)),
      }));
  }

  private async describeExistingFile(
    rootPath: string,
    path: string,
    scope: ServerConfigurationFile["scope"],
  ): Promise<ServerConfigurationFile | undefined> {
    try {
      const filePath = await this.resolveSafeExistingFile(rootPath, path);
      const fileStat = await this.fileSystem.stat(filePath);
      if (!fileStat.isFile() || fileStat.size > maximumConfigurationBytes) return undefined;
      return {
        path,
        name: basename(path),
        kind: configurationFileKind(path),
        scope,
      };
    } catch (error) {
      if (isMissingPathError(error)) return undefined;
      throw error;
    }
  }

  private async isSafeDirectory(rootPath: string, path: string): Promise<boolean> {
    try {
      const directoryStat = await this.fileSystem.stat(path);
      if (!directoryStat.isDirectory()) return false;
      const canonicalPath = await this.fileSystem.realpath(path);
      return isWithinRoot(rootPath, canonicalPath);
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
  }

  private async resolveSafeExistingFile(rootPath: string, path: string): Promise<string> {
    const candidate = resolve(rootPath, ...path.split("/"));
    if (!isWithinRoot(rootPath, candidate)) throw new Error("配置路径超出服务器实例目录。");
    const canonicalPath = await this.fileSystem.realpath(candidate);
    if (!isWithinRoot(rootPath, canonicalPath))
      throw new Error("配置文件符号链接超出服务器实例目录。");
    return canonicalPath;
  }

  private async readDocument(
    instanceId: string,
    descriptor: ServerConfigurationFile,
    filePath: string,
  ): Promise<ServerConfigurationDocument> {
    const fileStat = await this.fileSystem.stat(filePath);
    if (!fileStat.isFile() || fileStat.size > maximumConfigurationBytes) {
      throw new RangeError("配置文件不存在或超过 1 MB。");
    }
    const bytes = await this.fileSystem.readFile(filePath);
    if (bytes.byteLength > maximumConfigurationBytes) {
      throw new RangeError("配置文件不存在或超过 1 MB。");
    }
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(hasBom ? bytes.slice(3) : bytes);
    } catch {
      throw new Error("配置文件不是有效的 UTF-8 文本，已拒绝编辑以避免损坏。");
    }
    return {
      ...descriptor,
      instanceId,
      content,
      revision: createHash("sha256").update(bytes).digest("hex"),
      encoding: hasBom ? "utf-8-bom" : "utf-8",
      modifiedAt: fileStat.mtime.toISOString(),
    };
  }
}

function parseWriteRequest(value: unknown): ServerConfigurationWriteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("配置保存请求必须是对象。");
  }
  const record = value as Record<string, unknown>;
  const content = record.content;
  const expectedRevision = record.expectedRevision;
  if (typeof content !== "string" || content.includes("\0")) {
    throw new TypeError("配置内容必须是不含空字符的文本。");
  }
  if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(expectedRevision)) {
    throw new TypeError("配置版本标识无效。");
  }
  return {
    instanceId: expectNonEmptyString(record.instanceId, "服务器实例 ID"),
    path: expectRelativeConfigurationPath(record.path),
    content,
    expectedRevision,
  };
}

function expectRelativeConfigurationPath(value: unknown): string {
  const path = expectNonEmptyString(value, "配置相对路径");
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError("配置路径必须是规范的实例内相对路径。");
  }
  return path;
}

function expectNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label}不能为空。`);
  return value;
}

function configurationFileKind(path: string): ServerConfigurationFileKind {
  const extension = extname(path).toLowerCase();
  if (extension === ".properties") return "properties";
  if (extension === ".yml" || extension === ".yaml") return "yaml";
  if (extension === ".json") return "json";
  if (extension === ".toml" || extension === ".conf") return "toml";
  return "text";
}

function safeBackupName(path: string): string {
  return path.replace(/[^a-zA-Z0-9._-]+/gu, "__");
}

function isWithinRoot(rootPath: string, candidate: string): boolean {
  const relation = relative(rootPath, candidate);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (Reflect.get(error, "code") === "ENOENT" || Reflect.get(error, "code") === "ENOTDIR")
  );
}
