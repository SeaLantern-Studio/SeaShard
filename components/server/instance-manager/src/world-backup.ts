import { Zip, ZipDeflate } from "fflate";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ServerInstanceSnapshot } from "@seashard/contracts";
import type { ServerWorldBackupSnapshot } from "./types";
import { resolveWorldStorageDirectories } from "./world-storage";

const backupDirectoryPrefix = "backups-";
const maximumBackupNameAttempts = 100;

type WorldBackupSource = Awaited<ReturnType<typeof resolveWorldStorageDirectories>>[number];

export interface ServerWorldBackupOptions {
  readonly now?: () => string;
}

/**
 * 将已登记实例中的一个逻辑世界压缩为独立 ZIP 备份。
 *
 * unified 世界按原版客户端习惯把世界内容直接放在压缩包根部；split 世界保留
 * 各维度目录，避免 `level.dat` 和区域文件在多个维度之间互相覆盖。
 */
export async function createWorldBackup(
  instance: ServerInstanceSnapshot,
  requestedWorldId: unknown,
  options: ServerWorldBackupOptions = {},
): Promise<ServerWorldBackupSnapshot> {
  const sources = await resolveWorldStorageDirectories(instance, requestedWorldId);
  if (sources.length === 0) throw new Error("目标存档不存在或不属于当前服务器实例。");

  const createdAt = options.now?.() ?? new Date().toISOString();
  const timestamp = formatBackupTimestamp(createdAt);
  const worldDirectoryName = backupWorldDirectoryName(sources[0]!.groupId);
  const backupDirectory = resolve(
    instance.rootPath,
    `${backupDirectoryPrefix}${instance.id}`,
    worldDirectoryName,
  );
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

async function writeWorldArchive(
  destination: string,
  sources: readonly WorldBackupSource[],
): Promise<void> {
  const output = createWriteStream(destination, { flags: "wx" });
  try {
    await waitForOutputOpen(output);
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

function writeChunk(
  output: ReturnType<typeof createWriteStream>,
  chunk: Uint8Array,
): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    const onError = (error: Error) => {
      output.off("error", onError);
      rejectWrite(error);
    };
    output.once("error", onError);
    output.write(chunk, (error) => {
      output.off("error", onError);
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

function waitForOutputOpen(output: ReturnType<typeof createWriteStream>): Promise<void> {
  return waitForOutputEvent(output, "open");
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

function formatBackupTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new TypeError("世界备份时间必须是有效的 ISO 时间戳。");
  return (
    [
      date.getFullYear().toString().padStart(4, "0"),
      (date.getMonth() + 1).toString().padStart(2, "0"),
      date.getDate().toString().padStart(2, "0"),
    ].join("-") +
    "_" +
    [date.getHours(), date.getMinutes(), date.getSeconds()]
      .map((part) => part.toString().padStart(2, "0"))
      .join("-")
  );
}

function backupWorldDirectoryName(groupId: string): string {
  const directoryName = basename(groupId);
  if (!directoryName || directoryName === "." || directoryName === "..") {
    throw new TypeError("世界目录名无效，无法创建备份。");
  }
  return directoryName;
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    Reflect.get(error, "code") === "EEXIST"
  );
}
