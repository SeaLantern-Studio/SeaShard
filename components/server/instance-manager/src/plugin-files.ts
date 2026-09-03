import type { ServerInstalledPluginSnapshot, ServerInstanceSnapshot } from "@seashard/contracts";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const maximumInstalledPluginCount = 512;
const maximumPluginFileNameLength = 512;

export interface UpdatedInstalledPlugin {
  readonly plugin: ServerInstalledPluginSnapshot;
}

/** 插件目录只接受顶层 JAR；禁用状态使用与 Mod 相同的 .disabled 文件后缀。 */
export async function listInstalledPlugins(
  instance: ServerInstanceSnapshot,
): Promise<readonly ServerInstalledPluginSnapshot[]> {
  const directory = resolve(instance.rootPath, "plugins");
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
  const plugins: ServerInstalledPluginSnapshot[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))) {
    if (
      entry.isSymbolicLink() ||
      !entry.isFile() ||
      !/\.jar(?:\.disabled)?$/iu.test(entry.name) ||
      entry.name.length > maximumPluginFileNameLength
    ) {
      continue;
    }
    const absolutePath = join(directory, entry.name);
    const details = await stat(absolutePath);
    plugins.push(projectPlugin(instance, absolutePath, entry.name, details));
    if (plugins.length >= maximumInstalledPluginCount) break;
  }
  return plugins.sort(
    (left, right) =>
      right.addedAt.localeCompare(left.addedAt) || left.name.localeCompare(right.name, "zh-CN"),
  );
}

export async function setInstalledPluginDisabled(
  instance: ServerInstanceSnapshot,
  relativePathValue: unknown,
  disabled: boolean,
): Promise<UpdatedInstalledPlugin> {
  if (typeof disabled !== "boolean") throw new TypeError("插件禁用状态必须是布尔值。");
  const target = await resolvePluginTarget(instance, relativePathValue);
  const current = (await listInstalledPlugins(instance)).find(
    (plugin) => plugin.relativePath === target.relativePath,
  );
  if (!current) throw new Error(`找不到插件：${target.fileName}`);
  if (current.disabled === disabled) return { plugin: current };
  const nextFileName = disabled
    ? `${current.fileName}.disabled`
    : current.fileName.replace(/\.disabled$/iu, "");
  const nextPath = join(resolve(instance.rootPath, "plugins"), nextFileName);
  try {
    await lstat(nextPath);
    throw new Error(`目标插件文件已存在：${nextFileName}`);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  await assertOrdinaryFile(target.absolutePath);
  await rename(target.absolutePath, nextPath);
  const updated = (await listInstalledPlugins(instance)).find(
    (plugin) => plugin.relativePath === relative(instance.rootPath, nextPath).replaceAll("\\", "/"),
  );
  if (!updated) throw new Error("插件状态更新后无法重新读取。");
  return { plugin: updated };
}

export async function deleteInstalledPlugin(
  instance: ServerInstanceSnapshot,
  relativePathValue: unknown,
): Promise<void> {
  const target = await resolvePluginTarget(instance, relativePathValue);
  const current = (await listInstalledPlugins(instance)).find(
    (plugin) => plugin.relativePath === target.relativePath,
  );
  if (!current) throw new Error(`找不到插件：${target.fileName}`);
  await assertOrdinaryFile(target.absolutePath);
  await unlink(target.absolutePath);
}

function projectPlugin(
  instance: ServerInstanceSnapshot,
  absolutePath: string,
  fileName: string,
  details: Stats,
): ServerInstalledPluginSnapshot {
  return {
    instanceId: instance.id,
    relativePath: relative(instance.rootPath, absolutePath).replaceAll("\\", "/"),
    fileName,
    name: fileName.replace(/\.jar(?:\.disabled)?$/iu, ""),
    addedAt: fileAddedAt(details),
    disabled: /\.jar\.disabled$/iu.test(fileName),
  };
}

async function resolvePluginTarget(instance: ServerInstanceSnapshot, value: unknown) {
  if (
    typeof value !== "string" ||
    !/^plugins\/[^/]+\.jar(?:\.disabled)?$/iu.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    basename(value).length > maximumPluginFileNameLength
  ) {
    throw new TypeError("插件路径必须是实例 plugins 目录中的 JAR 文件。");
  }
  return {
    relativePath: value,
    fileName: basename(value),
    absolutePath: resolve(instance.rootPath, ...value.split("/")),
  };
}

async function assertOrdinaryFile(path: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error("目标插件已发生变化，请刷新后重试。");
  }
}

function fileAddedAt(details: Stats): string {
  for (const date of [details.birthtime, details.ctime, details.mtime]) {
    if (Number.isFinite(date.getTime()) && date.getTime() > 0) return date.toISOString();
  }
  return new Date(0).toISOString();
}

function isMissingPathError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
