import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, copyFile, link, mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { JsonValue } from "@seashard/plugin-sdk";
import type {
  DownloadManagerOptions,
  DownloadTaskSnapshot,
  DownloadTaskState,
  StartDownloadRequest,
} from "./types";

interface ParsedDownloadRequest extends StartDownloadRequest {
  readonly destinationPath: string;
  readonly connections: number;
  readonly headers: Readonly<Record<string, string>>;
}

interface InternalTask {
  readonly id: string;
  readonly request: ParsedDownloadRequest;
  readonly temporaryPath: string;
  readonly controller: AbortController;
  readonly createdAt: string;
  state: DownloadTaskState;
  downloadedBytes: number;
  totalBytes: number;
  connections: number;
  finishedAt?: string;
  error?: string;
  run: Promise<void>;
}

interface RemoteProbe {
  readonly supportsRanges: boolean;
  readonly totalBytes?: number;
}

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

const defaultConnectionCount = 8;
const defaultMaximumConnections = 32;
const defaultMinimumChunkBytes = 1024 * 1024;

/**
 * 公共下载任务管理器。
 *
 * 管理器只理解 URL、完整目标路径和可选完整性约束，不理解服务端、模组或插件目录。
 * 远端支持 Range 时使用并发分段写入；否则自动退回单连接流式下载。
 */
export class DownloadManager {
  private readonly fetchProvider: NonNullable<DownloadManagerOptions["fetchProvider"]>;
  private readonly defaultHeaders: Readonly<Record<string, string>>;
  private readonly defaultConnections: number;
  private readonly maxConnections: number;
  private readonly minimumChunkBytes: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly maxRetainedTasks: number;
  private readonly tasks = new Map<string, InternalTask>();
  private readonly activeDestinations = new Set<string>();
  private disposed = false;

  constructor(options: DownloadManagerOptions = {}) {
    this.fetchProvider = options.fetchProvider ?? (() => globalThis.fetch);
    this.defaultHeaders = normalizeHeaders(options.defaultHeaders ?? {});
    assertUncontrolledHeaders(this.defaultHeaders);
    this.maxConnections = expectPositiveSafeInteger(
      options.maxConnections ?? defaultMaximumConnections,
      "maxConnections",
    );
    this.defaultConnections = expectPositiveSafeInteger(
      options.defaultConnections ?? defaultConnectionCount,
      "defaultConnections",
    );
    if (this.defaultConnections > this.maxConnections) {
      throw new TypeError("download defaultConnections must not exceed maxConnections");
    }
    this.minimumChunkBytes = expectPositiveSafeInteger(
      options.minimumChunkBytes ?? defaultMinimumChunkBytes,
      "minimumChunkBytes",
    );
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.maxRetainedTasks = options.maxRetainedTasks ?? 128;
    if (!Number.isSafeInteger(this.maxRetainedTasks) || this.maxRetainedTasks < 0) {
      throw new TypeError("download maxRetainedTasks must be a non-negative safe integer");
    }
  }

  /** 创建后台任务；返回时下载可能仍处于 queued 或 downloading 状态。 */
  async start(value: unknown): Promise<DownloadTaskSnapshot> {
    if (this.disposed) throw new Error("download manager is stopped");
    const request = parseStartRequest(value, this.defaultConnections, this.maxConnections);
    if (this.activeDestinations.has(request.destinationPath)) {
      throw new Error(`download is already active for ${basename(request.destinationPath)}`);
    }

    // 在第一次 await 前预留目标，避免两个并发 start 同时通过“不存在”检查。
    this.activeDestinations.add(request.destinationPath);
    try {
      await assertDestinationAbsent(request.destinationPath);
      if (this.disposed) throw new Error("download manager is stopped");

      const id = this.createId();
      if (!id || this.tasks.has(id)) throw new Error(`download task id is unavailable: ${id}`);
      const task: InternalTask = {
        id,
        request,
        temporaryPath: `${request.destinationPath}.${id}.part`,
        controller: new AbortController(),
        createdAt: this.now().toISOString(),
        state: "queued",
        downloadedBytes: 0,
        totalBytes: 0,
        connections: 0,
        run: Promise.resolve(),
      };
      this.tasks.set(id, task);
      task.run = this.execute(task).finally(() => {
        this.activeDestinations.delete(request.destinationPath);
        this.pruneFinishedTasks();
      });
      return snapshotOf(task);
    } catch (error) {
      this.activeDestinations.delete(request.destinationPath);
      throw error;
    }
  }

  /** 查询任务的防御性快照。 */
  snapshot(taskId: string): DownloadTaskSnapshot | undefined {
    const task = this.tasks.get(taskId);
    return task ? snapshotOf(task) : undefined;
  }

  /** 等待指定任务完整退出，不使用轮询，也不会吞掉任务的最终快照。 */
  async wait(taskId: string): Promise<DownloadTaskSnapshot | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    await task.run;
    return snapshotOf(task);
  }

  /** 返回当前保留的全部任务，供统一下载中心展示。 */
  listTasks(): readonly DownloadTaskSnapshot[] {
    return [...this.tasks.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(snapshotOf);
  }

  /** 取消任务并等待管线退出，保证调用返回时组件已完成临时文件清理。 */
  async cancel(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || isFinished(task.state)) return false;
    task.controller.abort();
    await task.run;
    return true;
  }

  /** 停止组件时中止所有任务，并等待网络读取和磁盘写入全部收尾。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const running = [...this.tasks.values()].filter((task) => !isFinished(task.state));
    for (const task of running) task.controller.abort();
    await Promise.all(running.map((task) => task.run));
    this.activeDestinations.clear();
  }

  /** 执行单个任务；任何异常都在这里转换为稳定的任务终态。 */
  private async execute(task: InternalTask): Promise<void> {
    let ownsTemporaryFile = false;
    let temporaryFile: FileHandle | undefined;
    try {
      await mkdir(dirname(task.request.destinationPath), { recursive: true });
      task.state = "downloading";

      // 每个任务只获取一次传输实现；新任务会重新获取，从而采用最新的软件代理配置。
      const fetchImplementation = this.fetchProvider();
      const headers = createTransferHeaders(this.defaultHeaders, task.request.headers);
      const probe = await probeRemote(
        fetchImplementation,
        task.request.url,
        headers,
        task.controller.signal,
      );
      const knownTotalBytes = reconcileExpectedBytes(task.request.expectedBytes, probe.totalBytes);
      task.connections = chooseConnectionCount(
        task.request.connections,
        knownTotalBytes,
        probe.supportsRanges,
        this.minimumChunkBytes,
      );
      task.totalBytes = knownTotalBytes ?? 0;

      // wx 独占创建临时文件；只有成功取得句柄后，异常路径才有权删除它。
      temporaryFile = await open(task.temporaryPath, "wx");
      ownsTemporaryFile = true;
      const checksum = requestChecksum(task.request);
      let digest: string | undefined;
      if (task.connections > 1 && knownTotalBytes !== undefined) {
        await temporaryFile.truncate(knownTotalBytes);
        await downloadRanges(fetchImplementation, task, headers, temporaryFile, knownTotalBytes);
      } else {
        digest = await downloadSingle(
          fetchImplementation,
          task,
          headers,
          temporaryFile,
          knownTotalBytes,
          checksum?.algorithm,
        );
      }
      await temporaryFile.close();
      temporaryFile = undefined;
      task.controller.signal.throwIfAborted();

      if (task.totalBytes > 0 && task.downloadedBytes !== task.totalBytes) {
        throw new Error(
          `download length mismatch: expected ${task.totalBytes}, received ${task.downloadedBytes}`,
        );
      }
      if (task.request.expectedBytes === 0 && task.downloadedBytes !== 0) {
        throw new Error(`download length mismatch: expected 0, received ${task.downloadedBytes}`);
      }
      if (checksum) {
        // 并发分段会乱序到达，不能直接合并摘要状态，因此完成后顺序读取临时文件。
        digest ??= await hashFile(task.temporaryPath, checksum.algorithm);
        if (digest !== checksum.expected) {
          throw new Error(
            `download checksum mismatch: expected ${checksum.expected}, received ${digest}`,
          );
        }
      }
      task.controller.signal.throwIfAborted();

      // 最终路径只会在长度和可选摘要全部通过后出现。
      await publishVerifiedFile(task.temporaryPath, task.request.destinationPath);
      ownsTemporaryFile = false;
      task.state = "completed";
    } catch (error) {
      await temporaryFile?.close().catch(() => {});
      if (ownsTemporaryFile) await rm(task.temporaryPath, { force: true }).catch(() => {});
      if (task.controller.signal.aborted) {
        task.state = "cancelled";
        task.error = "download cancelled";
      } else {
        task.state = "failed";
        task.error = formatError(error);
      }
    } finally {
      task.finishedAt = this.now().toISOString();
    }
  }

  /** 仅裁剪结束任务，运行中的任务必须保留到资源收尾完成。 */
  private pruneFinishedTasks(): void {
    const finished = [...this.tasks.values()]
      .filter((task) => isFinished(task.state))
      .sort((left, right) => (left.finishedAt ?? "").localeCompare(right.finishedAt ?? ""));
    for (const task of finished.slice(0, Math.max(0, finished.length - this.maxRetainedTasks))) {
      this.tasks.delete(task.id);
    }
  }
}

/** 用一个字节的 Range 请求探测真实分段支持，避免只相信不可靠的 Accept-Ranges。 */
async function probeRemote(
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  baseHeaders: Headers,
  signal: AbortSignal,
): Promise<RemoteProbe> {
  const headers = new Headers(baseHeaders);
  headers.set("Range", "bytes=0-0");
  const response = await fetchImplementation(url, { headers, redirect: "follow", signal });
  try {
    if (response.status === 206) {
      const totalBytes = parseProbeContentRange(response.headers.get("content-range"));
      return { supportsRanges: true, totalBytes };
    }
    if (response.status === 416) {
      const totalBytes = parseUnsatisfiedContentRange(response.headers.get("content-range"));
      return { supportsRanges: false, ...(totalBytes === undefined ? {} : { totalBytes }) };
    }
    if (response.status !== 200) return { supportsRanges: false };
    const totalBytes = response.headers.has("content-encoding")
      ? undefined
      : parseContentLength(response.headers.get("content-length"));
    return { supportsRanges: false, ...(totalBytes === undefined ? {} : { totalBytes }) };
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

/** 单连接流式下载；同时统计进度和可选摘要，不会把完整文件读入内存。 */
async function downloadSingle(
  fetchImplementation: typeof globalThis.fetch,
  task: InternalTask,
  headers: Headers,
  temporaryFile: FileHandle,
  probedBytes: number | undefined,
  hashAlgorithm: "sha1" | "sha256" | "sha512" | undefined,
): Promise<string | undefined> {
  task.connections = 1;
  const response = await fetchImplementation(task.request.url, {
    headers,
    redirect: "follow",
    signal: task.controller.signal,
  });
  if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
  if (!response.body) throw new Error("download response has no body");

  const responseBytes = response.headers.has("content-encoding")
    ? undefined
    : parseContentLength(response.headers.get("content-length"));
  const expectedBytes = reconcileExpectedBytes(probedBytes, responseBytes);
  task.totalBytes = expectedBytes ?? 0;
  const hash = hashAlgorithm ? createHash(hashAlgorithm) : undefined;
  const meter = new Transform({
    transform: (chunk: Buffer, _encoding, callback) => {
      hash?.update(chunk);
      task.downloadedBytes += chunk.byteLength;
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    meter,
    temporaryFile.createWriteStream(),
    { signal: task.controller.signal },
  );
  if (expectedBytes !== undefined && task.downloadedBytes !== expectedBytes) {
    throw new Error(
      `download length mismatch: expected ${expectedBytes}, received ${task.downloadedBytes}`,
    );
  }
  return hash?.digest("hex");
}

/** 并发下载全部字节范围；任一分段失败会中止其他分段并等待它们完整退出。 */
async function downloadRanges(
  fetchImplementation: typeof globalThis.fetch,
  task: InternalTask,
  headers: Headers,
  temporaryFile: FileHandle,
  totalBytes: number,
): Promise<void> {
  const ranges = splitRanges(totalBytes, task.connections);
  task.connections = ranges.length;
  const groupController = new AbortController();
  const abortGroup = () => groupController.abort(task.controller.signal.reason);
  if (task.controller.signal.aborted) abortGroup();
  else task.controller.signal.addEventListener("abort", abortGroup, { once: true });
  try {
    const jobs = ranges.map((range) =>
      downloadRange(
        fetchImplementation,
        task,
        headers,
        temporaryFile,
        range,
        totalBytes,
        groupController.signal,
      ).catch((error: unknown) => {
        groupController.abort(error);
        throw error;
      }),
    );
    const results = await Promise.allSettled(jobs);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } finally {
    task.controller.signal.removeEventListener("abort", abortGroup);
  }
}

/** 请求并写入单个闭区间，严格校验 206 与 Content-Range。 */
async function downloadRange(
  fetchImplementation: typeof globalThis.fetch,
  task: InternalTask,
  baseHeaders: Headers,
  temporaryFile: FileHandle,
  range: ByteRange,
  totalBytes: number,
  signal: AbortSignal,
): Promise<void> {
  const headers = new Headers(baseHeaders);
  headers.set("Range", `bytes=${range.start}-${range.end}`);
  const response = await fetchImplementation(task.request.url, {
    headers,
    redirect: "follow",
    signal,
  });
  if (response.status !== 206) {
    throw new Error(`download range returned HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("download range response has no body");
  const expectedContentRange = `bytes ${range.start}-${range.end}/${totalBytes}`;
  if (response.headers.get("content-range") !== expectedContentRange) {
    throw new Error(`download range mismatch: expected ${expectedContentRange}`);
  }

  const expectedRangeBytes = range.end - range.start + 1;
  const declaredRangeBytes = parseContentLength(response.headers.get("content-length"));
  if (declaredRangeBytes !== undefined && declaredRangeBytes !== expectedRangeBytes) {
    throw new Error(
      `download range length mismatch: expected ${expectedRangeBytes}, received ${declaredRangeBytes}`,
    );
  }

  let rangeDownloaded = 0;
  for await (const chunk of Readable.fromWeb(
    response.body as Parameters<typeof Readable.fromWeb>[0],
  )) {
    const bytes = chunk as Uint8Array;
    if (rangeDownloaded + bytes.byteLength > expectedRangeBytes) {
      throw new Error(`download range exceeded ${expectedRangeBytes} bytes`);
    }
    await writeAllAt(temporaryFile, bytes, range.start + rangeDownloaded);
    rangeDownloaded += bytes.byteLength;
    task.downloadedBytes += bytes.byteLength;
  }
  if (rangeDownloaded !== expectedRangeBytes) {
    throw new Error(
      `download range length mismatch: expected ${expectedRangeBytes}, received ${rangeDownloaded}`,
    );
  }
}

/** FileHandle.write 允许短写；循环直到当前网络块全部落到指定偏移。 */
async function writeAllAt(file: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await file.write(bytes, written, bytes.byteLength - written, position + written);
    if (result.bytesWritten <= 0) throw new Error("download file write made no progress");
    written += result.bytesWritten;
  }
}

export function splitRanges(totalBytes: number, connections: number): readonly ByteRange[] {
  if (totalBytes === 0) return [];
  const count = Math.min(connections, totalBytes);
  const chunkSize = Math.floor(totalBytes / count);
  return Array.from({ length: count }, (_, index) => {
    const start = index * chunkSize;
    return {
      start,
      end: index === count - 1 ? totalBytes - 1 : start + chunkSize - 1,
    };
  });
}

function chooseConnectionCount(
  requested: number,
  totalBytes: number | undefined,
  supportsRanges: boolean,
  minimumChunkBytes: number,
): number {
  if (!supportsRanges || totalBytes === undefined || totalBytes === 0) return 1;
  const usefulConnections = Math.max(1, Math.ceil(totalBytes / minimumChunkBytes));
  return Math.min(requested, usefulConnections, totalBytes);
}

function reconcileExpectedBytes(
  expected: number | undefined,
  observed: number | undefined,
): number | undefined {
  if (expected !== undefined && observed !== undefined && expected !== observed) {
    throw new Error(`download length mismatch: expected ${expected}, received ${observed}`);
  }
  return expected ?? observed;
}

function parseStartRequest(
  value: unknown,
  defaultConnections: number,
  maxConnections: number,
): ParsedDownloadRequest {
  const record = expectRecord(value, "download request");
  const rawUrl = expectString(record.url, "url");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new TypeError("download url must be an absolute URL", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`download URL protocol is unsupported: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new TypeError("download URL must not contain embedded credentials");
  }

  const rawDestinationPath = expectString(record.destinationPath, "destinationPath");
  if (!isAbsolute(rawDestinationPath)) {
    throw new TypeError("download destinationPath must be absolute");
  }
  const destinationPath = normalize(rawDestinationPath);
  const expectedBytes = parseExpectedBytes(record.expectedBytes);
  const sha1 = parseDigest(record.sha1, "sha1", 40);
  const sha256 = parseDigest(record.sha256, "sha256", 64);
  const sha512 = parseDigest(record.sha512, "sha512", 128);
  if ([sha1, sha256, sha512].filter(Boolean).length > 1) {
    throw new TypeError("download request must provide only one checksum");
  }
  const connections = parseConnections(record.connections, defaultConnections, maxConnections);
  const headers = normalizeHeaders(record.headers ?? {});
  assertUncontrolledHeaders(headers);
  const metadata = record.metadata;
  if (metadata !== undefined && !isJsonValue(metadata)) {
    throw new TypeError("download metadata must be a JSON value");
  }
  return {
    url: url.href,
    destinationPath,
    connections,
    headers,
    ...(expectedBytes === undefined ? {} : { expectedBytes }),
    ...(sha1 ? { sha1 } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(sha512 ? { sha512 } : {}),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function parseExpectedBytes(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("download expectedBytes must be a non-negative safe integer");
  }
  return value as number;
}

function parseDigest(
  value: unknown,
  field: "sha1" | "sha256" | "sha512",
  hexadecimalLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length !== hexadecimalLength ||
    !/^[a-f0-9]+$/iu.test(value)
  ) {
    throw new TypeError(
      `download ${field} must be a ${hexadecimalLength}-character hexadecimal digest`,
    );
  }
  return value.toLowerCase();
}

function parseConnections(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const connections = expectPositiveSafeInteger(value, "connections");
  if (connections > maximum) {
    throw new TypeError(`download connections must not exceed ${maximum}`);
  }
  return connections;
}

function expectPositiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`download ${field} must be a positive safe integer`);
  }
  return value as number;
}

function normalizeHeaders(value: unknown): Readonly<Record<string, string>> {
  const record = expectRecord(value, "download headers");
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(record)) {
    if (typeof rawValue !== "string") {
      throw new TypeError(`download header must be a string: ${name}`);
    }
    headers.set(name, rawValue);
  }
  return Object.freeze(Object.fromEntries(headers.entries()));
}

function assertUncontrolledHeaders(headers: Readonly<Record<string, string>>): void {
  if ("range" in headers || "if-range" in headers) {
    throw new TypeError("download headers must not override Range or If-Range");
  }
}

/** Range 的字节含义必须对应原始文件，所以公共下载器统一要求 identity 编码。 */
function createTransferHeaders(
  defaults: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>>,
): Headers {
  const headers = new Headers(defaults);
  for (const [name, value] of Object.entries(overrides)) headers.set(name, value);
  headers.set("Accept-Encoding", "identity");
  return headers;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`download ${field} must be a non-empty string`);
  }
  return value;
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.every((child) => isJsonValue(child, seen));
}

function parseProbeContentRange(value: string | null): number {
  const match = /^bytes 0-0\/(\d+)$/.exec(value ?? "");
  const totalBytes = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) {
    throw new Error("download range probe returned an invalid Content-Range");
  }
  return totalBytes;
}

function parseUnsatisfiedContentRange(value: string | null): number | undefined {
  const match = /^bytes \*\/(\d+)$/.exec(value ?? "");
  if (!match) return undefined;
  const totalBytes = Number(match[1]);
  return Number.isSafeInteger(totalBytes) && totalBytes >= 0 ? totalBytes : undefined;
}

async function assertDestinationAbsent(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  throw new Error(`download destination already exists: ${basename(path)}`);
}

/**
 * 同目录硬链接提供原子且不覆盖的发布；不支持硬链接时退回 COPYFILE_EXCL。
 * 两条路径都会拒绝覆盖下载期间由其他进程创建的同名文件。
 */
async function publishVerifiedFile(temporaryPath: string, destinationPath: string): Promise<void> {
  try {
    await link(temporaryPath, destinationPath);
  } catch (error) {
    if (!hasErrorCode(error, "EPERM", "ENOSYS", "EXDEV")) throw error;
    await copyFile(temporaryPath, destinationPath, constants.COPYFILE_EXCL);
  }
  await rm(temporaryPath, { force: true }).catch(() => {});
}

async function hashFile(path: string, algorithm: "sha1" | "sha256" | "sha512"): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function requestChecksum(
  request: Pick<StartDownloadRequest, "sha1" | "sha256" | "sha512">,
): { algorithm: "sha1" | "sha256" | "sha512"; expected: string } | undefined {
  if (request.sha512) return { algorithm: "sha512", expected: request.sha512 };
  if (request.sha256) return { algorithm: "sha256", expected: request.sha256 };
  if (request.sha1) return { algorithm: "sha1", expected: request.sha1 };
  return undefined;
}

function snapshotOf(task: InternalTask): DownloadTaskSnapshot {
  const progress =
    task.state === "completed"
      ? 100
      : task.totalBytes > 0
        ? Math.min(100, (task.downloadedBytes / task.totalBytes) * 100)
        : 0;
  return {
    id: task.id,
    url: task.request.url,
    destinationPath: task.request.destinationPath,
    state: task.state,
    downloadedBytes: task.downloadedBytes,
    totalBytes: task.totalBytes,
    connections: task.connections,
    progress,
    createdAt: task.createdAt,
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.request.metadata === undefined ? {} : { metadata: task.request.metadata }),
  };
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isFinished(state: DownloadTaskState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && codes.includes(String(error.code)),
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
