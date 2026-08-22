import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Unzip, UnzipInflate, Zip, ZipDeflate, type UnzipFile } from "fflate";
import { lstat, mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ServerInstanceSnapshot, ServerWorldBackupSnapshot } from "@seashard/contracts";
import { supportsUnifiedWorldStorage } from "@seashard/contracts";
import { resolveWorldStorageDirectories } from "./world-storage";
import { createBackupDirectoryName, expectBackupDirectoryName } from "./directory-naming";
import { writePortableSeaShardInstanceManifest } from "./manifest";
const maximumBackupNameAttempts = 100;
const maximumRestoreEntries = 250_000;
const maximumRestoreBytes = 8 * 1024 * 1024 * 1024;

type WorldBackupSource = Awaited<ReturnType<typeof resolveWorldStorageDirectories>>[number];

export interface ServerWorldBackupOptions {
  readonly now?: () => string;
}

/** 将已登记实例中的一个逻辑世界压缩为独立 ZIP 备份。 */
export async function createWorldBackup(
  instance: ServerInstanceSnapshot,
  requestedWorldId: unknown,
  options: ServerWorldBackupOptions = {},
): Promise<ServerWorldBackupSnapshot> {
  const sources = await resolveWorldStorageDirectories(instance, requestedWorldId);
  if (sources.length === 0) throw new Error("目标存档不存在或不属于当前服务器实例。");
  const backupInstance = await ensureBackupDirectory(instance);

  const createdAt = options.now?.() ?? new Date().toISOString();
  const timestamp = formatBackupTimestamp(createdAt);
  const worldDirectoryName = backupWorldDirectoryName(sources[0]!.groupId);
  const backupDirectory = resolveBackupDirectory(backupInstance, worldDirectoryName);
  await mkdir(backupDirectory, { recursive: true });

  for (let attempt = 0; attempt < maximumBackupNameAttempts; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const fileName = `${timestamp}${suffix}.zip`;
    const destination = resolve(backupDirectory, fileName);
    try {
      await writeWorldArchive(destination, sources);
      const archiveSize = (await stat(destination)).size;
      return {
        instanceId: instance.id,
        worldId: sources[0]!.groupId,
        worldDirectoryName,
        fileName,
        createdAt,
        sizeBytes: archiveSize,
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        await rm(destination, { force: true });
        throw error;
      }
    }
  }

  throw new Error("同一时刻创建的世界备份数量超过限制。");
}

/** 只列出当前实例和目标世界备份根目录中的 ZIP 文件。 */
export async function listWorldBackups(
  instance: ServerInstanceSnapshot,
  requestedWorldId: unknown,
): Promise<readonly ServerWorldBackupSnapshot[]> {
  const sources = await resolveWorldStorageDirectories(instance, requestedWorldId);
  if (sources.length === 0) return [];
  if (!instance.backupDirectoryName) return [];
  const worldDirectoryName = backupWorldDirectoryName(sources[0]!.groupId);
  const backupDirectory = resolveBackupDirectory(instance, worldDirectoryName);
  let entries;
  try {
    entries = await readdir(backupDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const backups = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
      .map(async (entry) => {
        const filePath = resolve(backupDirectory, entry.name);
        const details = await stat(filePath);
        return {
          instanceId: instance.id,
          worldId: sources[0]!.groupId,
          worldDirectoryName,
          fileName: entry.name,
          createdAt: details.mtime.toISOString(),
          sizeBytes: details.size,
        } satisfies ServerWorldBackupSnapshot;
      }),
  );
  return backups.sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.fileName.localeCompare(left.fileName),
  );
}

/** 将备份安全恢复到同级临时目录，校验完成后再替换原世界目录。 */
export async function restoreWorldBackup(
  instance: ServerInstanceSnapshot,
  requestedWorldId: unknown,
  fileNameValue: unknown,
): Promise<void> {
  const sources = await resolveWorldStorageDirectories(instance, requestedWorldId);
  if (sources.length === 0) throw new Error("目标存档不存在或不属于当前服务器实例。");
  const fileName = expectBackupFileName(fileNameValue);
  const backupPath = await resolveExistingBackupPath(instance, sources, fileName);
  const unified = supportsUnifiedWorldStorage(instance.serverType);
  const stagingDirectory = resolve(
    unified ? dirname(sources[0]!.absolutePath) : sources[0]!.storageRoot,
    `.seashard-world-restore-${randomUUID()}`,
  );

  await mkdir(stagingDirectory, { recursive: false });
  try {
    await extractWorldArchive(backupPath, stagingDirectory, sources, unified);
    const replacements = sources.map((source) => ({
      target: source.absolutePath,
      staged: unified ? stagingDirectory : resolve(stagingDirectory, source.id),
    }));
    await validateRestoreDirectories(replacements);
    await replaceDirectoriesAtomically(replacements);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

/** 只允许删除目标世界备份根目录中的普通 ZIP 文件。 */
export async function deleteWorldBackup(
  instance: ServerInstanceSnapshot,
  requestedWorldId: unknown,
  fileNameValue: unknown,
): Promise<void> {
  const sources = await resolveWorldStorageDirectories(instance, requestedWorldId);
  if (sources.length === 0) throw new Error("目标存档不存在或不属于当前服务器实例。");
  const fileName = expectBackupFileName(fileNameValue);
  const backupPath = await resolveExistingBackupPath(instance, sources, fileName);
  await unlink(backupPath);
}

async function writeWorldArchive(
  destination: string,
  sources: readonly WorldBackupSource[],
): Promise<void> {
  const output = createWriteStream(destination, { flags: "wx" });
  try {
    await waitForOutputEvent(output, "open");
    const writer = new ZipFileWriter(output);
    for (const source of sources) {
      const archivePrefix = sources.length === 1 ? "" : source.id;
      await addDirectory(writer, source.absolutePath, archivePrefix);
    }
    writer.end();
    await writer.waitForWrites();
    output.end();
    await waitForOutputEvent(output, "finish");
  } catch (error) {
    output.destroy();
    throw error;
  }
}

async function addDirectory(
  writer: ZipFileWriter,
  directory: string,
  archivePrefix: string,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const sourcePath = resolve(directory, entry.name);
    const archivePath = archivePrefix ? `${archivePrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await addDirectory(writer, sourcePath, archivePath);
      continue;
    }
    if (!entry.isFile()) continue;
    await writer.addFile(sourcePath, archivePath);
  }
}

class ZipFileWriter {
  private readonly archive: Zip;
  private writeChain = Promise.resolve();
  private callbackError: unknown;

  constructor(private readonly output: ReturnType<typeof createWriteStream>) {
    this.archive = new Zip((error, chunk) => {
      if (error) {
        this.callbackError = error;
        return;
      }
      if (chunk) this.writeChain = this.writeChain.then(() => writeChunk(this.output, chunk));
    });
  }

  async addFile(sourcePath: string, archivePath: string): Promise<void> {
    const entry = new ZipDeflate(archivePath, { level: 6 });
    this.archive.add(entry);
    const source = createReadStream(sourcePath);
    try {
      for await (const chunk of source) {
        this.throwIfCallbackFailed();
        entry.push(chunk as Uint8Array, false);
        await this.waitForWrites();
      }
      entry.push(new Uint8Array(0), true);
      await this.waitForWrites();
    } finally {
      source.destroy();
    }
  }

  end(): void {
    this.throwIfCallbackFailed();
    this.archive.end();
  }

  async waitForWrites(): Promise<void> {
    await this.writeChain;
    this.throwIfCallbackFailed();
  }

  private throwIfCallbackFailed(): void {
    if (this.callbackError !== undefined) throw this.callbackError;
  }
}

async function extractWorldArchive(
  archivePath: string,
  stagingDirectory: string,
  sources: readonly WorldBackupSource[],
  unified: boolean,
): Promise<void> {
  const input = createReadStream(archivePath);
  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  const pending: Promise<void>[] = [];
  const names = new Set<string>();
  let extractionError: unknown;
  let entryCount = 0;
  let totalBytes = 0;

  unzipper.onfile = (file) => {
    if (extractionError) return;
    try {
      entryCount += 1;
      if (entryCount > maximumRestoreEntries) {
        throw new Error("备份文件包含的文件数量超过限制。");
      }
      const archiveName = normalizeArchivePath(file.name);
      if (!archiveName) return;
      if (!unified && !isAllowedSplitArchivePath(archiveName, sources)) {
        throw new Error("备份文件包含不属于目标存档的路径。");
      }
      if (names.has(archiveName)) throw new Error("备份文件包含重复路径。");
      names.add(archiveName);
      const destination = resolveInside(stagingDirectory, archiveName);
      const task = writeUnzipFile(file, destination, (bytes) => {
        totalBytes += bytes;
        if (totalBytes > maximumRestoreBytes) {
          throw new Error("备份解压后的文件总大小超过限制。");
        }
      });
      pending.push(task);
      void task.catch((error) => {
        extractionError ??= error;
      });
    } catch (error) {
      extractionError = error;
    }
  };

  try {
    for await (const chunk of input) {
      if (extractionError) throw extractionError;
      unzipper.push(chunk as Uint8Array);
    }
    unzipper.push(new Uint8Array(0), true);
    await Promise.all(pending);
    if (extractionError) throw extractionError;
  } finally {
    input.destroy();
  }
}

function writeUnzipFile(
  file: UnzipFile,
  destination: string,
  onBytes: (bytes: number) => void,
): Promise<void> {
  const task = (async () => {
    await mkdir(dirname(destination), { recursive: true });
    const output = createWriteStream(destination, { flags: "wx" });
    try {
      const finished = waitForOutputEvent(output, "finish");
      file.ondata = (error, chunk, final) => {
        try {
          if (error) throw error;
          if (chunk) {
            onBytes(chunk.byteLength);
            output.write(chunk);
          }
          if (final) output.end();
        } catch (cause) {
          output.destroy(cause instanceof Error ? cause : new Error(String(cause)));
        }
      };
      file.start();
      await finished;
    } catch (error) {
      output.destroy();
      throw error;
    }
  })();
  return task;
}

async function validateRestoreDirectories(
  replacements: readonly { target: string; staged: string }[],
): Promise<void> {
  for (const replacement of replacements) {
    const details = await stat(resolve(replacement.staged, "level.dat"));
    if (!details.isFile()) throw new Error("备份文件缺少有效的 level.dat。");
  }
}

async function replaceDirectoriesAtomically(
  replacements: readonly { target: string; staged: string }[],
): Promise<void> {
  const moved = replacements.map((replacement) => ({
    ...replacement,
    previous: `${replacement.target}.seashard-restore-old-${randomUUID()}`,
  }));
  try {
    for (const replacement of moved) await rename(replacement.target, replacement.previous);
    for (const replacement of moved) await rename(replacement.staged, replacement.target);
  } catch (error) {
    for (const replacement of [...moved].reverse()) {
      await rm(replacement.target, { recursive: true, force: true });
      try {
        await rename(replacement.previous, replacement.target);
      } catch {
        // 尽力回滚；原始异常仍然交给调用方处理。
      }
    }
    throw error;
  }
  await Promise.all(
    moved.map((replacement) => rm(replacement.previous, { recursive: true, force: true })),
  );
}

async function ensureBackupDirectory(
  instance: ServerInstanceSnapshot,
): Promise<ServerInstanceSnapshot> {
  if (instance.backupDirectoryName) return instance;
  const updated = {
    ...instance,
    backupDirectoryName: createBackupDirectoryName(),
  };
  await writePortableSeaShardInstanceManifest(updated);
  return updated;
}

function resolveBackupDirectory(
  instance: ServerInstanceSnapshot,
  worldDirectoryName: string,
): string {
  return resolve(
    instance.rootPath,
    expectBackupDirectoryName(instance.backupDirectoryName),
    worldDirectoryName,
  );
}
async function resolveExistingBackupPath(
  instance: ServerInstanceSnapshot,
  sources: readonly WorldBackupSource[],
  fileName: string,
): Promise<string> {
  const backupDirectory = resolveBackupDirectory(
    instance,
    backupWorldDirectoryName(sources[0]!.groupId),
  );
  const filePath = resolveInside(backupDirectory, fileName);
  const details = await lstat(filePath);
  if (!details.isFile()) throw new Error("目标备份不是普通文件。");
  return filePath;
}

function normalizeArchivePath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || isAbsolute(value)) {
    throw new Error(`备份文件路径不安全：${value}`);
  }
  const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
  if (!trimmed) return "";
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`备份文件路径不安全：${value}`);
  }
  return segments.join("/");
}

function isAllowedSplitArchivePath(
  archiveName: string,
  sources: readonly WorldBackupSource[],
): boolean {
  return sources.some(
    (source) => archiveName === source.id || archiveName.startsWith(`${source.id}/`),
  );
}

function resolveInside(root: string, child: string): string {
  const target = resolve(root, child);
  const relativePath = relative(resolve(root), target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("备份文件路径超出允许目录。");
  }
  return target;
}

function expectBackupFileName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value === "." ||
    value === ".." ||
    /[\\/]/u.test(value) ||
    basename(value) !== value ||
    !value.toLowerCase().endsWith(".zip")
  ) {
    throw new TypeError("备份文件名必须是当前世界备份根目录中的 ZIP 文件名。");
  }
  return value;
}

function backupWorldDirectoryName(groupId: string): string {
  const directoryName = basename(groupId);
  if (!directoryName || directoryName === "." || directoryName === "..") {
    throw new TypeError("世界目录名无效，无法创建备份。");
  }
  return directoryName;
}

function formatBackupTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("世界备份时间必须是有效的 ISO 时间戳。");
  }
  return (
    [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map((part) => part.toString().padStart(2, "0"))
      .join("-") +
    "_" +
    [date.getHours(), date.getMinutes(), date.getSeconds()]
      .map((part) => part.toString().padStart(2, "0"))
      .join("-")
  );
}

function waitForOutputEvent(
  output: ReturnType<typeof createWriteStream>,
  event: "open" | "finish",
): Promise<void> {
  return new Promise((resolveEvent, rejectEvent) => {
    const onEvent = (): void => {
      cleanup();
      resolveEvent();
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectEvent(error);
    };
    const cleanup = (): void => {
      output.off(event, onEvent);
      output.off("error", onError);
    };
    output.once(event, onEvent);
    output.once("error", onError);
  });
}

function writeChunk(
  output: ReturnType<typeof createWriteStream>,
  chunk: Uint8Array,
): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    const onError = (error: Error): void => {
      output.off("error", onError);
      rejectWrite(error);
    };
    output.once("error", onError);
    output.write(chunk, (error?: Error | null) => {
      output.off("error", onError);
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    Reflect.get(error, "code") === "EEXIST"
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    Reflect.get(error, "code") === "ENOENT"
  );
}
