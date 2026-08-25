import {
  pluginDeveloperControlProtocolVersion,
  type PluginDeveloperControlLaunch,
  type PluginDeveloperControlRequest,
  type PluginDeveloperControlResponse,
  type PluginDeveloperControlSuccess,
  type PluginDeveloperHostSnapshot,
  type PluginDeveloperSessionDescriptor,
} from "@seashard/plugin-system";
import type { PluginKernel } from "@seashard/plugin-system";
import { timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

const maximumRequestBytes = 1024 * 1024;

export interface PluginDeveloperControlOptions {
  readonly kernel: PluginKernel;
  readonly launch: PluginDeveloperControlLaunch;
  readonly startedAt: string;
  pluginId(): string | undefined;
  runtimeIds(): readonly string[];
  logRuntimeIds(): readonly string[];
  refreshDevelopmentPlugin(): Promise<void>;
  requestShutdown(): void;
}

/**
 * 启动只绑定本机 Socket 的 CLI 开发控制面。
 *
 * Socket 只接受单行 JSON 和启动时生成的高熵令牌；它只公开固定诊断、重载、安装和退出动作，
 * 不会把任意 Service 调用或 Provider 对象暴露到进程外。
 */
export async function startPluginDeveloperControl(
  options: PluginDeveloperControlOptions,
): Promise<() => Promise<void>> {
  await mkdir(dirname(options.launch.descriptorPath), { recursive: true });
  if (process.platform !== "win32") await rm(options.launch.socketPath, { force: true });

  const server = createServer((socket) => acceptSocket(socket, options));
  await listen(server, options.launch.socketPath);
  await writeFile(
    options.launch.descriptorPath,
    `${JSON.stringify(createDescriptor(options), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    await close(server);
    await rm(options.launch.descriptorPath, { force: true });
    if (process.platform !== "win32") await rm(options.launch.socketPath, { force: true });
  };
}

function acceptSocket(socket: Socket, options: PluginDeveloperControlOptions): void {
  socket.setEncoding("utf8");
  let body = "";
  let settled = false;

  socket.on("data", (chunk: string) => {
    if (settled) return;
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > maximumRequestBytes) {
      settled = true;
      respond(socket, {
        id: "unknown",
        ok: false,
        error: "developer control request is too large",
      });
      return;
    }
    const newline = body.indexOf("\n");
    if (newline < 0) return;
    settled = true;
    void processRequest(body.slice(0, newline), options).then(
      (response) => respond(socket, response),
      (error) =>
        respond(socket, {
          id: readRequestId(body),
          ok: false,
          error: formatError(error),
        }),
    );
  });
  socket.once("error", () => undefined);
}

async function processRequest(
  line: string,
  options: PluginDeveloperControlOptions,
): Promise<PluginDeveloperControlResponse> {
  const request = parseRequest(line);
  if (!safeTokenEqual(request.token, options.launch.token)) {
    return { id: request.id, ok: false, error: "developer control authentication failed" };
  }

  switch (request.action) {
    case "snapshot":
      return success(request.id, "snapshot", createSnapshot(options));
    case "refresh":
      if (options.launch.mode !== "development") {
        throw new Error("plugin refresh requires a development session");
      }
      await options.refreshDevelopmentPlugin();
      return success(request.id, "refresh", createSnapshot(options));
    case "logs": {
      const runtimeIds = request.runtimeId ? [request.runtimeId] : [...options.logRuntimeIds()];
      const records = runtimeIds
        .flatMap((runtimeId) => options.kernel.runtimeLifecycle(runtimeId))
        .sort((left, right) => left.sequence - right.sequence);
      return success(request.id, "logs", records);
    }
    case "reload": {
      const runtimeIds = request.runtimeId ? [request.runtimeId] : [...options.runtimeIds()];
      if (runtimeIds.length === 0) throw new Error("development session has no reloadable runtime");
      for (const runtimeId of runtimeIds) await options.kernel.reload(runtimeId);
      return success(request.id, "reload", createSnapshot(options));
    }
    case "install": {
      const prepared =
        request.source === "directory"
          ? await options.kernel.prepareDirectory(request.sourcePath)
          : await options.kernel.prepareArchive(request.sourcePath);
      try {
        const record = await prepared.commit({
          digest: prepared.digest,
          acknowledgeFullMachineAccess: true,
        });
        await options.kernel.selectPackageVersionAndEnable(record);
        return success(request.id, "install", {
          pluginId: record.manifest.id,
          version: record.manifest.version,
          digest: record.digest,
          source: "installed",
        });
      } finally {
        await prepared.dispose();
      }
    }
    case "shutdown":
      setImmediate(() => options.requestShutdown());
      return success(request.id, "shutdown", { accepted: true });
  }
}

function createSnapshot(options: PluginDeveloperControlOptions): PluginDeveloperHostSnapshot {
  return {
    session: createDescriptor(options),
    runtime: options.kernel.runtimeSnapshot(),
    services: options.kernel.services.snapshot(),
  };
}

function createDescriptor(
  options: PluginDeveloperControlOptions,
): PluginDeveloperSessionDescriptor {
  const pluginId = options.pluginId();
  return {
    protocolVersion: pluginDeveloperControlProtocolVersion,
    sessionId: options.launch.sessionId,
    token: options.launch.token,
    socketPath: options.launch.socketPath,
    descriptorPath: options.launch.descriptorPath,
    pid: process.pid,
    startedAt: options.startedAt,
    mode: options.launch.mode,
    ...(options.launch.pluginRoot ? { pluginRoot: options.launch.pluginRoot } : {}),
    ...(pluginId ? { pluginId } : {}),
    runtimeIds: [...options.runtimeIds()].sort((left, right) => left.localeCompare(right)),
  };
}

function parseRequest(line: string): PluginDeveloperControlRequest {
  const value = JSON.parse(line) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("developer control request must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.token !== "string") {
    throw new TypeError("developer control request identity is invalid");
  }
  if (
    record.action !== "snapshot" &&
    record.action !== "refresh" &&
    record.action !== "reload" &&
    record.action !== "logs" &&
    record.action !== "install" &&
    record.action !== "shutdown"
  ) {
    throw new TypeError("developer control action is invalid");
  }
  if (
    (record.action === "reload" || record.action === "logs") &&
    record.runtimeId !== undefined &&
    typeof record.runtimeId !== "string"
  ) {
    throw new TypeError("developer control runtimeId is invalid");
  }
  if (record.action === "install") {
    if (typeof record.sourcePath !== "string") {
      throw new TypeError("developer control sourcePath is invalid");
    }
    if (record.source !== "archive" && record.source !== "directory") {
      throw new TypeError("developer control install source is invalid");
    }
  }
  return record as PluginDeveloperControlRequest;
}

function success<Action extends PluginDeveloperControlSuccess["action"]>(
  id: string,
  action: Action,
  result: Extract<PluginDeveloperControlSuccess, { action: Action }>["result"],
): Extract<PluginDeveloperControlSuccess, { action: Action }> {
  return { id, ok: true, action, result } as Extract<
    PluginDeveloperControlSuccess,
    { action: Action }
  >;
}

function safeTokenEqual(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return (
    receivedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(receivedBytes, expectedBytes)
  );
}

function readRequestId(body: string): string {
  try {
    const value = JSON.parse(body.slice(0, body.indexOf("\n"))) as { id?: unknown };
    return typeof value.id === "string" ? value.id : "unknown";
  } catch {
    return "unknown";
  }
}

function respond(socket: Socket, response: PluginDeveloperControlResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
