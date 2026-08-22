import type { ServerInstanceSnapshot, ServerInstalledModSnapshot } from "@seashard/contracts";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readModMetadata } from "./mod-metadata";

const maximumInstalledModCount = 512;
const maximumModFileNameLength = 512;

export interface UpdatedInstalledMod {
  readonly previousRelativePath: string;
  readonly mod: ServerInstalledModSnapshot;
}

export interface DeletedInstalledMod {
  readonly relativePaths: readonly string[];
}

/** 扫描实例标准 Mod 目录；禁用文件保留在列表中，供管理页面直接恢复。 */
export async function listInstalledMods(
  instance: ServerInstanceSnapshot,
): Promise<readonly ServerInstalledModSnapshot[]> {
  const result: ServerInstalledModSnapshot[] = [];
  for (const directory of modDirectories(instance)) {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name, "zh-CN"),
    )) {
      if (!isInstalledModEntry(entry)) continue;
      result.push(await readInstalledMod(instance, directory, entry));
      if (result.length >= maximumInstalledModCount) return sortInstalledMods(result);
    }
  }
  return sortInstalledMods(result);
}

/** 通过追加或移除 .disabled 后缀切换加载器可见状态。 */
export async function setInstalledModDisabled(
  instance: ServerInstanceSnapshot,
  relativePathValue: unknown,
  disabled: boolean,
): Promise<UpdatedInstalledMod> {
  if (typeof disabled !== "boolean") throw new TypeError("MOD 禁用状态必须是布尔值。");
  const target = await resolveInstalledModTarget(instance, relativePathValue);
  const current = (await listInstalledMods(instance)).find(
    (mod) => mod.relativePath === target.relativePath,
  );
  if (!current) throw new Error(`找不到 MOD：${target.fileName}`);
  if (current.disabled === disabled)
    return { previousRelativePath: current.relativePath, mod: current };

  const nextFileName = disabled
    ? `${current.fileName}.disabled`
    : enabledFileName(current.fileName);
  const nextPath = join(target.directory, nextFileName);
  try {
    await lstat(nextPath);
    throw new Error(`目标 MOD 文件已存在：${nextFileName}`);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const details = await lstat(target.absolutePath);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error("目标 MOD 已发生变化，请刷新后重试。");
  }
  await rename(target.absolutePath, nextPath);

  const nextRelativePath = relative(instance.rootPath, nextPath).replaceAll("\\", "/");
  const updated = (await listInstalledMods(instance)).find(
    (mod) => mod.relativePath === nextRelativePath,
  );
  if (!updated) throw new Error("MOD 状态更新后无法重新读取。");
  const mod =
    updated.resourceSource || !current.resourceSource
      ? updated
      : { ...updated, resourceSource: current.resourceSource };

  return { previousRelativePath: current.relativePath, mod };
}

/** 删除标准 Mod 目录中的单个文件，并返回来源索引需要清理的路径。 */
export async function deleteInstalledMod(
  instance: ServerInstanceSnapshot,
  relativePathValue: unknown,
): Promise<DeletedInstalledMod> {
  const target = await resolveInstalledModTarget(instance, relativePathValue);
  const current = (await listInstalledMods(instance)).find(
    (mod) => mod.relativePath === target.relativePath,
  );
  if (!current) throw new Error(`找不到 MOD：${target.fileName}`);
  const details = await lstat(target.absolutePath);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error("目标 MOD 已发生变化，请刷新后重试。");
  }
  await unlink(target.absolutePath);
  const paths = new Set<string>([current.relativePath]);
  if (current.disabled) {
    paths.add(
      relative(
        instance.rootPath,
        join(target.directory, enabledFileName(current.fileName)),
      ).replaceAll("\\", "/"),
    );
  }
  return { relativePaths: [...paths] };
}

function modDirectories(instance: ServerInstanceSnapshot): readonly string[] {
  return [resolve(instance.rootPath, "mods"), resolve(instance.rootPath, "server", "mods")];
}

function isInstalledModEntry(entry: Dirent): boolean {
  return (
    !entry.isSymbolicLink() &&
    entry.isFile() &&
    /\.jar(?:\.disabled)?$/iu.test(entry.name) &&
    entry.name.length <= maximumModFileNameLength
  );
}

async function readInstalledMod(
  instance: ServerInstanceSnapshot,
  directory: string,
  entry: Dirent,
): Promise<ServerInstalledModSnapshot> {
  const absolutePath = join(directory, entry.name);
  const relativePath = relative(instance.rootPath, absolutePath).replaceAll("\\", "/");
  const metadata = await readModMetadata(absolutePath);
  const source =
    instance.resourceSources?.mods?.[relativePath] ??
    instance.resourceSources?.mods?.[enabledRelativePath(relativePath)];
  const details = await stat(absolutePath);
  const fallbackName = entry.name.replace(/\.jar(?:\.disabled)?$/iu, "");
  return {
    instanceId: instance.id,
    relativePath,
    fileName: entry.name,
    name: metadata.name || fallbackName,
    ...(metadata.version || source?.version
      ? { version: metadata.version ?? source?.version }
      : {}),
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(metadata.iconDataUrl ? { iconDataUrl: metadata.iconDataUrl } : {}),
    addedAt: fileAddedAt(details),
    disabled: isDisabledFileName(entry.name),
    ...(source ? { resourceSource: source } : {}),
  };
}

async function resolveInstalledModTarget(
  instance: ServerInstanceSnapshot,
  relativePathValue: unknown,
): Promise<{ absolutePath: string; relativePath: string; directory: string; fileName: string }> {
  const relativePath = expectModRelativePath(relativePathValue);
  const absolutePath = resolve(instance.rootPath, ...relativePath.split("/"));
  const directory = dirname(absolutePath);
  if (!modDirectories(instance).some((candidate) => candidate === directory)) {
    throw new TypeError("MOD 路径必须位于实例标准 Mod 目录中。");
  }
  return { absolutePath, relativePath, directory, fileName: basename(absolutePath) };
}

function expectModRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    !/^(?:mods|server\/mods)\/[^/]+\.jar(?:\.disabled)?$/iu.test(value) ||
    basename(value).length > maximumModFileNameLength
  ) {
    throw new TypeError("MOD 路径必须是实例标准 Mod 目录中的 JAR 文件。");
  }
  return value;
}

function enabledRelativePath(relativePath: string): string {
  return relativePath.replace(/\.disabled$/iu, "");
}

function enabledFileName(fileName: string): string {
  return fileName.replace(/\.disabled$/iu, "");
}

function isDisabledFileName(fileName: string): boolean {
  return /\.jar\.disabled$/iu.test(fileName);
}

function sortInstalledMods(
  mods: readonly ServerInstalledModSnapshot[],
): ServerInstalledModSnapshot[] {
  return [...mods].sort(
    (left, right) =>
      right.addedAt.localeCompare(left.addedAt) ||
      left.name.localeCompare(right.name, "zh-CN") ||
      left.relativePath.localeCompare(right.relativePath, "zh-CN"),
  );
}

function fileAddedAt(details: Stats): string {
  for (const date of [details.birthtime, details.ctime, details.mtime]) {
    if (date instanceof Date && Number.isFinite(date.getTime()) && date.getTime() > 0) {
      return date.toISOString();
    }
  }
  return new Date(0).toISOString();
}

function isMissingPathError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
