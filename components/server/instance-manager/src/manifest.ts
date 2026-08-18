import type { ServerInstanceSnapshot } from "@seashard/contracts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { PortableSeaShardInstanceManifest, PortableServerInformationManifest } from "./types";

export const portableInstanceMetadataDirectoryName = ".server-info";
export const portableServerInformationFileName = "server.json";
export const portableSeaShardInstanceFileName = "seashard.json";

/** 生成服务器自身信息；核心路径相对实例根，精确构建由原始产物名和哈希标识。 */
export function createPortableServerInformationManifest(
  instance: ServerInstanceSnapshot,
): PortableServerInformationManifest {
  const artifact =
    instance.coreArtifactFileName || instance.artifactSha256
      ? {
          ...(instance.coreArtifactFileName ? { fileName: instance.coreArtifactFileName } : {}),
          ...(instance.artifactSha256 ? { sha256: instance.artifactSha256 } : {}),
        }
      : undefined;
  return {
    schemaVersion: 1,
    minecraft: instance.gameVersion ? { version: instance.gameVersion } : {},
    core: {
      path: relativePathInside(instance.rootPath, instance.coreJarPath, "core JAR"),
      ...(instance.serverType ? { type: instance.serverType } : {}),
      ...(artifact ? { artifact } : {}),
    },
  };
}

/** 生成 SeaShard 私有实例数据；图标必须留在中立元数据目录中。 */
export function createPortableSeaShardInstanceManifest(
  instance: ServerInstanceSnapshot,
): PortableSeaShardInstanceManifest {
  const metadataDirectory = resolve(instance.rootPath, portableInstanceMetadataDirectoryName);
  const icon = instance.iconPath
    ? relativePathInside(metadataDirectory, instance.iconPath, "SeaShard icon")
    : undefined;
  return {
    schemaVersion: 1,
    id: instance.id,
    name: instance.name,
    storageMode: instance.storageMode,
    source: instance.source,
    ...(icon ? { icon } : {}),
    ...(instance.lastStartedAt ? { lastStartedAt: instance.lastStartedAt } : {}),
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

/**
 * 先提交服务器事实，再以 seashard.json 作为实例登记入口。
 * SQLite 只在两个文件均成功落盘后登记后者的绝对路径。
 */
export async function writePortableInstanceManifests(
  instance: ServerInstanceSnapshot,
): Promise<string> {
  const directory = resolve(instance.rootPath, portableInstanceMetadataDirectoryName);
  await writeJsonAtomically(
    directory,
    portableServerInformationFileName,
    createPortableServerInformationManifest(instance),
  );
  return writeJsonAtomically(
    directory,
    portableSeaShardInstanceFileName,
    createPortableSeaShardInstanceManifest(instance),
  );
}

/** 只更新 SeaShard 私有字段，不重写服务器自身信息。 */
export async function writePortableSeaShardInstanceManifest(
  instance: ServerInstanceSnapshot,
): Promise<string> {
  const directory = resolve(instance.rootPath, portableInstanceMetadataDirectoryName);
  return writeJsonAtomically(
    directory,
    portableSeaShardInstanceFileName,
    createPortableSeaShardInstanceManifest(instance),
  );
}

/** SQLite 索引 seashard.json；读取时再合并同目录的 server.json。 */
export async function readPortableInstanceManifests(
  seaShardManifestPath: string,
): Promise<ServerInstanceSnapshot> {
  if (!isAbsolute(seaShardManifestPath)) {
    throw new TypeError("SeaShard instance manifest path must be absolute");
  }
  const resolvedSeaShardPath = resolve(seaShardManifestPath);
  const metadataDirectory = dirname(resolvedSeaShardPath);
  if (
    basename(resolvedSeaShardPath) !== portableSeaShardInstanceFileName ||
    basename(metadataDirectory) !== portableInstanceMetadataDirectoryName
  ) {
    throw new TypeError("SeaShard instance manifest must use .server-info/seashard.json");
  }
  const rootPath = dirname(metadataDirectory);
  const [seaShard, server] = await Promise.all([
    readJsonObject(resolvedSeaShardPath, "seashard.json"),
    readJsonObject(resolve(metadataDirectory, portableServerInformationFileName), "server.json"),
  ]);
  if (seaShard.schemaVersion !== 1) {
    throw new TypeError("SeaShard instance manifest schemaVersion must be 1");
  }
  if (server.schemaVersion !== 1) {
    throw new TypeError("server information manifest schemaVersion must be 1");
  }

  const storageMode = expectEnum(seaShard.storageMode, "seashard.json storageMode", [
    "managed",
    "external",
  ]);
  const source = expectEnum(seaShard.source, "seashard.json source", ["downloaded", "imported"]);
  const icon =
    seaShard.icon === undefined
      ? undefined
      : expectRelativePath(seaShard.icon, "seashard.json icon");
  const core = expectRecord(server.core, "server.json core");
  const minecraft = expectRecord(server.minecraft, "server.json minecraft");
  const corePath = expectRelativePath(core.path, "server.json core.path");
  const artifact =
    core.artifact === undefined
      ? undefined
      : expectRecord(core.artifact, "server.json core.artifact");
  const artifactFileName =
    artifact?.fileName === undefined
      ? undefined
      : expectString(artifact.fileName, "server.json core.artifact.fileName");
  const artifactSha256 =
    artifact?.sha256 === undefined
      ? undefined
      : expectSha256(artifact.sha256, "server.json core.artifact.sha256");

  return {
    id: expectString(seaShard.id, "seashard.json id"),
    name: expectString(seaShard.name, "seashard.json name"),
    rootPath,
    coreJarPath: resolve(rootPath, corePath),
    ...(icon ? { iconPath: resolve(metadataDirectory, icon) } : {}),
    storageMode,
    source,
    ...(core.type === undefined
      ? {}
      : { serverType: expectString(core.type, "server.json core.type") }),
    ...(minecraft.version === undefined
      ? {}
      : {
          gameVersion: expectString(minecraft.version, "server.json minecraft.version"),
        }),
    ...(artifactFileName ? { coreArtifactFileName: artifactFileName } : {}),
    ...(artifactSha256 ? { artifactSha256 } : {}),
    ...(seaShard.lastStartedAt === undefined
      ? {}
      : {
          lastStartedAt: expectString(seaShard.lastStartedAt, "seashard.json lastStartedAt"),
        }),
    createdAt: expectString(seaShard.createdAt, "seashard.json createdAt"),
    updatedAt: expectString(seaShard.updatedAt, "seashard.json updatedAt"),
  };
}

async function writeJsonAtomically(
  directory: string,
  fileName: string,
  value: unknown,
): Promise<string> {
  const destination = resolve(directory, fileName);
  const temporary = resolve(directory, `${fileName}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

async function readJsonObject(
  manifestPath: string,
  label: string,
): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  return expectRecord(value, label);
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`server instance ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function relativePathInside(rootPath: string, targetPath: string, label: string): string {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  const relativePath = relative(root, target);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    basename(target) === "" ||
    dirname(target) === target
  ) {
    throw new TypeError(`server instance ${label} must be inside its allowed directory`);
  }
  return relativePath.replaceAll("\\", "/");
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`server instance ${field} must be a non-empty string`);
  }
  return value;
}

function expectRelativePath(value: unknown, field: string): string {
  const portablePath = expectString(value, field).replaceAll("\\", "/");
  const segments = portablePath.split("/");
  if (
    portablePath.startsWith("/") ||
    /^[a-z]:/iu.test(portablePath) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError(`server instance ${field} must be a relative child path`);
  }
  return portablePath;
}

function expectSha256(value: unknown, field: string): string {
  const sha256 = expectString(value, field);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new TypeError(`server instance ${field} must be a SHA-256 digest`);
  }
  return sha256;
}

function expectEnum<const Value extends string>(
  value: unknown,
  field: string,
  allowed: readonly Value[],
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    throw new TypeError(`server instance ${field} is invalid`);
  }
  return value as Value;
}
