import {
  serverFileManagerContract,
  serverRuntimeContract,
  type ServerFileEntry,
  type ServerTextFileDocument,
  type ServerTextFileWriteRequest,
  type ServerRuntimeService,
} from "@seashard/contracts";
import type { JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import {
  serverInstanceManagerContract,
  type ServerInstanceManagerService,
} from "@seashard/server-instance-manager";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

const maximumTextFileBytes = 1024 * 1024;
const maximumDirectoryEntries = 2_000;
const protectedRootEntries = new Set([".seashard", "seashard.json", "server.json"]);

export const serverFileManagerManifest: PluginManifest = {
  id: "seashard.server-file-manager",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-file-manager.host",
      runtime: "host",
      execution: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron", "node", "docker"],
      activationScopes: ["global"],
      permissions: [serverInstanceManagerContract, serverRuntimeContract],
    },
  ],
  compatibility: { seaShard: ">=0.0.0 <1.0.0" },
};

export function createServerFileManagerModule(): PluginModule {
  return {
    inject: [serverInstanceManagerContract, serverRuntimeContract],
    provides: [serverFileManagerContract],
    apply(context) {
      const manager = new ServerFileManager(
        context.service<ServerInstanceManagerService>(serverInstanceManagerContract),
        context.service<ServerRuntimeService>(serverRuntimeContract),
      );
      context.provide(serverFileManagerContract, {
        list: async (instanceId, directory) =>
          asJsonValue(await manager.list(instanceId, directory)),
        readText: async (instanceId, path) => asJsonValue(await manager.readText(instanceId, path)),
        writeText: async (request) => asJsonValue(await manager.writeText(request)),
        createDirectory: async (instanceId, path) => {
          await manager.createDirectory(instanceId, path);
          return null;
        },
        delete: async (instanceId, path) => {
          await manager.delete(instanceId, path);
          return null;
        },
      });
    },
  };
}

/** 所有调用先由实例 ID 取得根目录，再执行相对路径和符号链接双重校验。 */
export class ServerFileManager {
  constructor(
    private readonly instances: ServerInstanceManagerService,
    private readonly runtime: ServerRuntimeService,
  ) {}

  async list(
    instanceIdValue: unknown,
    directoryValue: unknown,
  ): Promise<readonly ServerFileEntry[]> {
    const { rootPath } = await this.findInstance(instanceIdValue);
    const path = expectRelativePath(directoryValue, true);
    const target = await resolveSafePath(rootPath, path, false);
    const details = await stat(target);
    if (!details.isDirectory()) throw new Error("目标路径不是目录。");
    const entries = await readdir(target, { withFileTypes: true });
    const result: ServerFileEntry[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name, "zh-CN"),
    )) {
      if (result.length >= maximumDirectoryEntries) break;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
      const absolutePath = resolve(target, entry.name);
      const entryDetails = await stat(absolutePath);
      result.push({
        path: relative(rootPath, absolutePath).replaceAll("\\", "/"),
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
        size: entry.isFile() ? entryDetails.size : 0,
        modifiedAt: entryDetails.mtime.toISOString(),
      });
    }
    return result;
  }

  async readText(instanceIdValue: unknown, pathValue: unknown): Promise<ServerTextFileDocument> {
    const instance = await this.findInstance(instanceIdValue);
    const path = expectRelativePath(pathValue, false);
    const target = await resolveSafePath(instance.rootPath, path, false);
    const details = await stat(target);
    if (!details.isFile()) throw new Error("目标路径不是文件。");
    if (details.size > maximumTextFileBytes) throw new Error("仅支持读取 1 MiB 以内的文本文件。");
    const bytes = await readFile(target);
    if (bytes.includes(0)) throw new Error("目标文件包含二进制内容，不能作为文本编辑。");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("目标文件不是有效的 UTF-8 文本。");
    }
    return {
      instanceId: instance.id,
      path,
      content,
      revision: createHash("sha256").update(bytes).digest("hex"),
      modifiedAt: details.mtime.toISOString(),
    };
  }

  async writeText(requestValue: unknown): Promise<ServerTextFileDocument> {
    const request = expectWriteRequest(requestValue);
    const instance = await this.findInstance(request.instanceId);
    await this.assertStopped(instance.id, "写入文件");
    const target = await resolveSafePath(instance.rootPath, request.path, true);
    await assertDirectory(dirname(target));
    if (request.expectedRevision !== undefined) {
      const current = await this.readText(instance.id, request.path);
      if (current.revision !== request.expectedRevision) {
        throw new Error("文件已被其他程序修改，请刷新后重试。");
      }
    }
    await writeFile(target, request.content, "utf8");
    return this.readText(instance.id, request.path);
  }

  async createDirectory(instanceIdValue: unknown, pathValue: unknown): Promise<void> {
    const instance = await this.findInstance(instanceIdValue);
    await this.assertStopped(instance.id, "创建目录");
    const path = expectRelativePath(pathValue, false);
    const target = await resolveSafePath(instance.rootPath, path, true);
    await assertDirectory(dirname(target));
    await mkdir(target);
  }

  async delete(instanceIdValue: unknown, pathValue: unknown): Promise<void> {
    const instance = await this.findInstance(instanceIdValue);
    await this.assertStopped(instance.id, "删除文件");
    const path = expectRelativePath(pathValue, false);
    const target = await resolveSafePath(instance.rootPath, path, false);
    const details = await lstat(target);
    if (details.isSymbolicLink()) throw new Error("不允许删除符号链接。");
    if (details.isDirectory()) await rmdir(target);
    else if (details.isFile()) await unlink(target);
    else throw new Error("目标路径类型不受支持。");
  }

  private async findInstance(instanceIdValue: unknown) {
    const instanceId = expectIdentifier(instanceIdValue, "instanceId");
    const instance = (await this.instances.list()).find(({ id }) => id === instanceId);
    if (!instance) throw new Error(`找不到服务器实例：${instanceId}`);
    return instance;
  }

  private async assertStopped(instanceId: string, operation: string): Promise<void> {
    const snapshot = await this.runtime.get(instanceId);
    if (snapshot.state !== "stopped" && snapshot.state !== "failed") {
      throw new Error(`${operation}前必须先停止服务器。`);
    }
  }
}

function expectWriteRequest(value: unknown): ServerTextFileWriteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("文件写入请求必须是对象。");
  }
  const record = value as Record<string, unknown>;
  const content = record.content;
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > maximumTextFileBytes) {
    throw new TypeError("文件内容必须是 1 MiB 以内的 UTF-8 文本。");
  }
  const expectedRevision = record.expectedRevision;
  if (
    expectedRevision !== undefined &&
    (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(expectedRevision))
  ) {
    throw new TypeError("文件 revision 无效。");
  }
  return {
    instanceId: expectIdentifier(record.instanceId, "instanceId"),
    path: expectRelativePath(record.path, false),
    content,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

function expectIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new TypeError(`${label} 无效。`);
  }
  return value;
}

function expectRelativePath(value: unknown, allowRoot: boolean): string {
  if (
    typeof value !== "string" ||
    value.length > 1_024 ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new TypeError("实例相对路径无效。");
  }
  const path = value.replace(/^\/+|\/+$/gu, "");
  if (!path) {
    if (allowRoot) return "";
    throw new TypeError("实例相对路径不能为空。");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new TypeError("实例相对路径无效。");
  }
  if (protectedRootEntries.has(parts[0]!)) throw new Error("该 SeaShard 元数据路径不可编辑。");
  return parts.join("/");
}

async function resolveSafePath(
  rootPath: string,
  relativePath: string,
  allowMissingLeaf: boolean,
): Promise<string> {
  const root = resolve(rootPath);
  const parts = relativePath ? relativePath.split("/") : [];
  const target = resolve(root, ...parts);
  const relation = relative(root, target);
  if (
    relation.startsWith("..") ||
    relation.includes(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new TypeError("实例相对路径越过了实例根目录。");
  }
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) throw new Error("实例文件路径不能经过符号链接。");
    } catch (error) {
      if (isMissingPathError(error) && allowMissingLeaf && index === parts.length - 1) break;
      throw error;
    }
  }
  return target;
}

async function assertDirectory(path: string): Promise<void> {
  const details = await stat(path);
  if (!details.isDirectory()) throw new Error(`父路径不是目录：${basename(path)}`);
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function isMissingPathError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
