import type {
  ServerInstanceSnapshot,
  ServerWorldDatapackKind,
  ServerWorldDatapackSnapshot,
} from "@seashard/contracts";
import type { Dirent } from "node:fs";
import { lstat, readdir, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { readDatapackMetadata } from "./datapack-metadata";
import {
  readWorldDatapackDisabledNames,
  writeWorldDatapackDisabled,
} from "./world-datapack-config";
import { resolveWorldDatapackDirectory } from "./world-storage";

const maximumWorldDatapackCount = 256;
const maximumWorldDatapackFileNameLength = 512;

export interface DeletedWorldDatapackPaths {
  readonly relativePaths: readonly string[];
}

/** 扫描指定逻辑世界的直接数据包目录，启用状态来自世界的原生 level.dat。 */
export async function listWorldDatapacks(
  instance: ServerInstanceSnapshot,
  requestedWorldId: unknown,
): Promise<readonly ServerWorldDatapackSnapshot[]> {
  const target = await resolveWorldDatapackDirectory(instance, requestedWorldId);
  let entries;
  try {
    entries = await readdir(target.absolutePath, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const candidates = entries
    .filter((entry) => isDatapackEntry(entry))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    .slice(0, maximumWorldDatapackCount);
  const disabledFileNames = await readWorldDatapackDisabledNames(dirname(target.absolutePath));
  const datapacks = await Promise.all(
    candidates.map((entry) =>
      readDatapackEntry(
        instance,
        target.worldId,
        target.absolutePath,
        target.storageRoot,
        disabledFileNames,
        entry,
      ),
    ),
  );
  return datapacks
    .filter((value): value is ServerWorldDatapackSnapshot => value !== undefined)
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.fileName.localeCompare(right.fileName, "zh-CN"),
    );
}

/** 为指定数据包切换启用状态；文件名保持不变，由 Minecraft 原生列表记录状态。 */
export async function setWorldDatapackDisabled(
  instance: ServerInstanceSnapshot,
  requestedWorldId: unknown,
  fileNameValue: unknown,
  disabled: boolean,
): Promise<ServerWorldDatapackSnapshot> {
  if (typeof disabled !== "boolean") {
    throw new TypeError("数据包禁用状态必须是布尔值。");
  }
  const target = await resolveDatapackTarget(instance, requestedWorldId, fileNameValue);
  if (target.datapack.disabled === disabled) return target.datapack;

  await writeWorldDatapackDisabled(
    dirname(target.directory.absolutePath),
    target.datapack.fileName,
    disabled,
  );
  const refreshed = await listWorldDatapacks(instance, target.directory.worldId);
  const updated = refreshed.find(({ fileName }) => fileName === target.datapack.fileName);
  if (!updated) throw new Error("数据包状态更新后无法重新读取。");
  return updated;
}

/** 删除指定数据包，并返回需要从来源索引移除的相对路径。 */
export async function deleteWorldDatapack(
  instance: ServerInstanceSnapshot,
  requestedWorldId: unknown,
  fileNameValue: unknown,
): Promise<DeletedWorldDatapackPaths> {
  const target = await resolveDatapackTarget(instance, requestedWorldId, fileNameValue);
  const datapackPath = join(target.directory.absolutePath, target.storageFileName);
  const details = await lstat(datapackPath);
  if (details.isSymbolicLink()) throw new Error("不允许删除符号链接数据包。");
  if (target.datapack.kind === "directory") {
    if (!details.isDirectory()) throw new Error("目标数据包已发生变化，请刷新后重试。");
    await rm(datapackPath, { recursive: true, force: false });
  } else {
    if (!details.isFile()) throw new Error("目标数据包已发生变化，请刷新后重试。");
    await unlink(datapackPath);
  }
  const relativePath = relative(target.directory.storageRoot, datapackPath).replaceAll("\\", "/");
  return { relativePaths: [relativePath] };
}

function isDatapackEntry(entry: Dirent): boolean {
  if (entry.isSymbolicLink()) return false;
  return entry.isDirectory() || (entry.isFile() && entry.name.toLowerCase().endsWith(".zip"));
}

async function readDatapackEntry(
  instance: ServerInstanceSnapshot,
  worldId: string,
  datapackDirectory: string,
  storageRoot: string,
  disabledFileNames: ReadonlySet<string>,
  entry: Dirent,
): Promise<ServerWorldDatapackSnapshot | undefined> {
  const entryPath = join(datapackDirectory, entry.name);
  const fileName = entry.name;
  const disabled = disabledFileNames.has(fileName);
  let kind: ServerWorldDatapackKind;
  if (entry.isDirectory()) {
    if (!(await hasPackMetadata(entryPath))) return undefined;
    kind = "directory";
  } else if (entry.isFile() && fileName.toLowerCase().endsWith(".zip")) {
    kind = "archive";
  } else {
    return undefined;
  }
  const metadata = await readDatapackMetadata(entryPath, kind);
  const details = await stat(entryPath);
  const relativePath = relative(storageRoot, entryPath).replaceAll("\\", "/");
  const resourceSource = instance.resourceSources?.datapacks?.[relativePath];
  return {
    instanceId: instance.id,
    worldId,
    ...(resourceSource ? { resourceSource } : {}),
    fileName,
    kind,
    disabled,
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(metadata.iconDataUrl ? { iconDataUrl: metadata.iconDataUrl } : {}),
    updatedAt: details.mtime.toISOString(),
  };
}

async function resolveDatapackTarget(
  instance: ServerInstanceSnapshot,
  requestedWorldId: unknown,
  fileNameValue: unknown,
): Promise<{
  readonly directory: Awaited<ReturnType<typeof resolveWorldDatapackDirectory>>;
  readonly datapack: ServerWorldDatapackSnapshot;
  readonly storageFileName: string;
}> {
  const fileName = expectWorldDatapackFileName(fileNameValue);
  const directory = await resolveWorldDatapackDirectory(instance, requestedWorldId);
  const datapack = (await listWorldDatapacks(instance, directory.worldId)).find(
    (candidate) => candidate.fileName === fileName,
  );
  if (!datapack) throw new Error(`找不到数据包：${fileName}`);

  const storagePath = join(directory.absolutePath, fileName);
  let details;
  try {
    details = await lstat(storagePath);
  } catch (error) {
    if (isMissingPathError(error)) throw new Error(`找不到数据包：${fileName}`);
    throw error;
  }
  if (
    details.isSymbolicLink() ||
    (datapack.kind === "directory" && !details.isDirectory()) ||
    (datapack.kind === "archive" && !details.isFile())
  ) {
    throw new Error("目标数据包已发生变化，请刷新后重试。");
  }
  return { directory, datapack, storageFileName: fileName };
}

function expectWorldDatapackFileName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value === "." ||
    value === ".." ||
    value.length > maximumWorldDatapackFileNameLength ||
    value.includes("\0") ||
    /[\\/]/u.test(value) ||
    basename(value) !== value
  ) {
    throw new TypeError("数据包名称必须是当前世界数据包目录中的文件或文件夹名称。");
  }
  return value;
}

async function hasPackMetadata(directory: string): Promise<boolean> {
  try {
    return (await stat(join(directory, "pack.mcmeta"))).isFile();
  } catch {
    return false;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
