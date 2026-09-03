import { mkdir, open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

const maximumLogBytes = 5 * 1024 * 1024;
const retainedLogFiles = 5;

export class ServerControllerLogger {
  private writeTask: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    readonly file: string,
    private readonly handle: FileHandle,
  ) {}

  static async open(file: string): Promise<ServerControllerLogger> {
    await mkdir(dirname(file), { recursive: true });
    await rotateLogs(file);
    return new ServerControllerLogger(file, await open(file, "a"));
  }

  info(message: string): Promise<void> {
    const safeMessage = redactDiagnostic(message);
    console.log(safeMessage);
    return this.append("INFO", safeMessage);
  }

  error(message: string): Promise<void> {
    const safeMessage = redactDiagnostic(message);
    console.error(safeMessage);
    return this.append("ERROR", safeMessage);
  }

  /** 文件写入保持调用顺序；关闭时等待队列排空，避免正常退出丢失最后一条日志。 */
  private append(level: "INFO" | "ERROR", message: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const line = `${new Date().toISOString()} ${level} ${message}\n`;
    this.writeTask = this.writeTask.then(() => this.handle.appendFile(line, "utf8"));
    return this.writeTask;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.writeTask;
    } finally {
      await this.handle.close();
    }
  }
}

/** 日志跨 API、插件和系统命令边界，写盘前统一遮蔽常见凭据形态。 */
export function redactDiagnostic(message: string): string {
  return message
    .replace(
      /\b(authorization\s*[:=]\s*(?:bearer\s+)?)([^\s,;]+)/giu,
      (_match, prefix: string) => `${prefix}[REDACTED]`,
    )
    .replace(
      /\b(password|passwd|token|secret|api[-_]?key)(["']?\s*[:=]\s*["']?)([^"'\s,}\]]+)/giu,
      (_match, name: string, separator: string) => `${name}${separator}[REDACTED]`,
    )
    .replace(/([?&](?:token|key|secret|password)=)[^&#\s]+/giu, "$1[REDACTED]");
}

async function rotateLogs(file: string): Promise<void> {
  const details = await stat(file).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!details || details.size < maximumLogBytes) return;
  await rm(`${file}.${retainedLogFiles}`, { force: true });
  for (let index = retainedLogFiles - 1; index >= 1; index -= 1) {
    const source = `${file}.${index}`;
    const destination = `${file}.${index + 1}`;
    await rm(destination, { force: true });
    await rename(source, destination).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
  }
  await rename(file, `${file}.1`);
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
