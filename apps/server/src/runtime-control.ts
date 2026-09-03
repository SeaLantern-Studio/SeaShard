import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

const runtimeSchemaVersion = 1;
const requestTimeoutMilliseconds = 2_000;
const maximumResponseBytes = 64 * 1024;

export interface ServerRuntimeDescriptor {
  readonly schemaVersion: typeof runtimeSchemaVersion;
  readonly pid: number;
  readonly startedAt: string;
  readonly controlUrl: string;
  readonly token: string;
}

export interface ServerRuntimeHealth {
  readonly status: "ready";
  readonly pid: number;
  readonly startedAt: string;
  readonly uptimeSeconds: number;
}

/**
 * 每个数据目录只允许一个 Controller 持有写入租约。锁内随机身份同时保护清理过程：旧进程
 * 退出时只能删除自己的锁与控制描述，不会误删已经接管目录的新进程状态。
 */
export class ServerControllerProcessLease {
  readonly startedAt = new Date().toISOString();
  private readonly lockPath: string;
  private readonly runtimePath: string;
  private released = false;
  private constructor(
    readonly dataRoot: string,
    readonly token: string,
    private readonly lockHandle: FileHandle,
  ) {
    this.lockPath = join(dataRoot, "server-controller.lock");
    this.runtimePath = join(dataRoot, "server-controller.runtime.json");
  }

  static async acquire(dataRoot: string): Promise<ServerControllerProcessLease> {
    await mkdir(dataRoot, { recursive: true });
    const lockPath = join(dataRoot, "server-controller.lock");
    const identity = randomBytes(32).toString("hex");
    let handle: FileHandle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existingPid = await readLockPid(lockPath);
      if (existingPid !== undefined && processIsAlive(existingPid)) {
        throw new Error(`已有 Server Controller 正在使用该数据目录（PID ${existingPid}）`);
      }
      await rm(lockPath, { force: true });
      handle = await open(lockPath, "wx", 0o600);
    }
    const lease = new ServerControllerProcessLease(dataRoot, identity, handle);
    await handle.writeFile(
      `${JSON.stringify({ schemaVersion: runtimeSchemaVersion, pid: process.pid, token: identity })}\n`,
      "utf8",
    );
    return lease;
  }

  async publish(controlUrl: string): Promise<ServerRuntimeDescriptor> {
    const descriptor: ServerRuntimeDescriptor = {
      schemaVersion: runtimeSchemaVersion,
      pid: process.pid,
      startedAt: this.startedAt,
      controlUrl,
      token: this.token,
    };
    const temporary = `${this.runtimePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rm(this.runtimePath, { force: true });
    await rename(temporary, this.runtimePath);
    return descriptor;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      await this.lockHandle.close();
    } finally {
      await removeOwnedFile(this.runtimePath, this.token);
      await removeOwnedFile(this.lockPath, this.token);
    }
  }
}

/** 通过只允许本机访问的带令牌端点确认真实进程，避免把陈旧 PID 当成健康服务。 */
export async function queryServerRuntime(
  dataRoot: string,
): Promise<ServerRuntimeHealth | undefined> {
  const descriptor = await readRuntimeDescriptor(dataRoot);
  if (!descriptor) return undefined;
  try {
    const response = await requestRuntime(descriptor, "GET", "/api/service/status");
    return parseRuntimeHealth(response);
  } catch {
    return undefined;
  }
}

/** 请求 Controller 走完整的 Host、Kernel、Web 和日志关闭顺序。 */
export async function stopServerRuntime(dataRoot: string): Promise<boolean> {
  const descriptor = await readRuntimeDescriptor(dataRoot);
  if (!descriptor) return false;
  try {
    await requestRuntime(descriptor, "POST", "/api/service/shutdown");
  } catch {
    return false;
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await queryServerRuntime(dataRoot))) return true;
    await delay(100);
  }
  throw new Error("Server Controller 在 15 秒内没有正常退出");
}

export async function readRuntimeDescriptor(
  dataRoot: string,
): Promise<ServerRuntimeDescriptor | undefined> {
  try {
    const value = JSON.parse(
      await readFile(join(dataRoot, "server-controller.runtime.json"), "utf8"),
    ) as Partial<ServerRuntimeDescriptor>;
    if (
      value.schemaVersion !== runtimeSchemaVersion ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.startedAt !== "string" ||
      typeof value.controlUrl !== "string" ||
      typeof value.token !== "string" ||
      value.token.length !== 64
    ) {
      return undefined;
    }
    return value as ServerRuntimeDescriptor;
  } catch (error) {
    if (hasCode(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function requestRuntime(
  descriptor: ServerRuntimeDescriptor,
  method: "GET" | "POST",
  pathname: string,
): Promise<unknown> {
  const url = new URL(pathname, descriptor.controlUrl);
  const requestFunction = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolvePromise, reject) => {
    const request = requestFunction(
      url,
      {
        method,
        headers: { Authorization: `Bearer ${descriptor.token}` },
        ...(url.protocol === "https:" ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
          if (Buffer.byteLength(body, "utf8") > maximumResponseBytes) {
            request.destroy(new Error("Server Controller 控制响应过大"));
          }
        });
        response.once("end", () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`Server Controller 控制请求失败（HTTP ${response.statusCode}）`));
            return;
          }
          try {
            resolvePromise(body ? JSON.parse(body) : undefined);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(requestTimeoutMilliseconds, () =>
      request.destroy(new Error("Server Controller 控制请求超时")),
    );
    request.once("error", reject);
    request.end();
  });
}

function parseRuntimeHealth(value: unknown): ServerRuntimeHealth {
  if (
    !value ||
    typeof value !== "object" ||
    !("status" in value) ||
    value.status !== "ready" ||
    !("pid" in value) ||
    !Number.isSafeInteger(value.pid) ||
    !("startedAt" in value) ||
    typeof value.startedAt !== "string" ||
    !("uptimeSeconds" in value) ||
    typeof value.uptimeSeconds !== "number"
  ) {
    throw new TypeError("Server Controller 健康响应无效");
  }
  return value as ServerRuntimeHealth;
}

async function readLockPid(file: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as { pid?: unknown };
    return Number.isSafeInteger(value.pid) ? (value.pid as number) : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

async function removeOwnedFile(file: string, token: string): Promise<void> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as { token?: unknown };
    if (value.token === token) await rm(file, { force: true });
  } catch (error) {
    if (!hasCode(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
