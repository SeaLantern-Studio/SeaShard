import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { configError } from "./document";

export const maximumConfigBytes = 1024 * 1024;
const writerLockStaleMs = 30_000;

export async function readBoundedFile(path: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maximumConfigBytes) {
    throw new RangeError(`Agent models.yml 不存在或超过 1 MB：${path}`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > maximumConfigBytes) {
    throw new RangeError(`Agent models.yml 不存在或超过 1 MB：${path}`);
  }
  return bytes;
}

export function decodeUtf8(bytes: Uint8Array, configPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw configError(configPath, "文件不是有效的 UTF-8 文本");
  }
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function writeFileAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function withWriterLock<T>(
  configPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${configPath}.lock`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const metadata = await stat(lockPath).catch(() => undefined);
      if (metadata && Date.now() - metadata.mtimeMs > writerLockStaleMs) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await delay(25);
    }
  }
  if (!handle) throw new Error("模型供应商配置正在被另一个 SeaShard 进程写入");
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
