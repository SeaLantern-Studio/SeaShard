import type { JsonValue } from "@seashard/plugin-sdk";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { resolveHostControlLocation } from "./location";
import {
  hostControlProtocolVersion,
  type HostControlDescriptor,
  type HostControlEventName,
  type HostControlFrame,
  type HostControlHandlers,
  type HostControllerIdentity,
  type HostControllerSnapshot,
  type HostControlRequestFrame,
  type HostControlSnapshot,
  type HostServiceCall,
} from "./protocol";

const maximumFrameBytes = 8 * 1024 * 1024;

interface ControllerConnection {
  readonly socket: Socket;
  readonly identity: HostControllerIdentity;
  readonly connectedAt: string;
}

export interface HostControlServer {
  readonly descriptor: HostControlDescriptor;
  snapshot(): HostControlSnapshot;
  broadcast(
    event: Exclude<HostControlEventName, "control-snapshot" | "control-requested">,
    payload: JsonValue,
  ): void;
  dispose(): Promise<void>;
}

export interface StartHostControlServerOptions {
  readonly dataRoot: string;
  readonly handlers: HostControlHandlers;
  readonly startedAt?: string;
}

/**
 * Host 是控制权的唯一裁决点。每条长连接对应一个 Controller，读取可并发，写调用则
 * 在进入领域 Service 前校验当前 holder，避免旧控制端继续发出操作。
 */
export async function startHostControlServer(
  options: StartHostControlServerOptions,
): Promise<HostControlServer> {
  const location = await resolveHostControlLocation(options.dataRoot);
  await mkdir(dirname(location.descriptorPath), { recursive: true });
  if (process.platform !== "win32") await rm(location.socketPath, { force: true });

  const token = randomBytes(32).toString("hex");
  const descriptor: HostControlDescriptor = {
    protocolVersion: hostControlProtocolVersion,
    socketPath: location.socketPath,
    descriptorPath: location.descriptorPath,
    token,
    pid: process.pid,
    startedAt: options.startedAt ?? new Date().toISOString(),
  };
  const connections = new Map<Socket, ControllerConnection>();
  let revision = 0;
  let holderSessionId: string | undefined;
  let pending:
    | {
        readonly requestId: string;
        readonly requesterSessionId: string;
        readonly requestedAt: string;
      }
    | undefined;
  let disposed = false;

  const server = createServer((socket) => acceptSocket(socket));
  await listen(server, location.socketPath);
  const temporaryDescriptorPath = `${location.descriptorPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryDescriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    // Windows rename 不覆盖已有目标；监听成功已经证明旧 Host 不存在，此处可清理崩溃残留。
    await rm(location.descriptorPath, { force: true });
    await rename(temporaryDescriptorPath, location.descriptorPath);
  } catch (error) {
    await rm(temporaryDescriptorPath, { force: true });
    await close(server);
    if (process.platform !== "win32") await rm(location.socketPath, { force: true });
    throw error;
  }

  function controllerSnapshot(connection: ControllerConnection): HostControllerSnapshot {
    return { ...connection.identity, connectedAt: connection.connectedAt };
  }

  function findBySessionId(sessionId: string): ControllerConnection | undefined {
    return [...connections.values()].find(
      (connection) => connection.identity.sessionId === sessionId,
    );
  }

  function snapshot(): HostControlSnapshot {
    const controllers = [...connections.values()]
      .map(controllerSnapshot)
      .sort((left, right) => left.connectedAt.localeCompare(right.connectedAt));
    const holder = holderSessionId ? findBySessionId(holderSessionId) : undefined;
    const requester = pending ? findBySessionId(pending.requesterSessionId) : undefined;
    return {
      revision,
      controllers,
      ...(holder ? { holder: controllerSnapshot(holder) } : {}),
      ...(pending && requester
        ? {
            pending: {
              requestId: pending.requestId,
              requester: controllerSnapshot(requester),
              requestedAt: pending.requestedAt,
            },
          }
        : {}),
    };
  }

  function send(socket: Socket, frame: HostControlFrame): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
  }

  function broadcast(event: HostControlEventName, payload: JsonValue): void {
    for (const connection of connections.values()) {
      send(connection.socket, { type: "event", event, payload });
    }
  }

  function publishControlSnapshot(): void {
    broadcast("control-snapshot", snapshot() as unknown as JsonValue);
  }

  function advanceControlState(): void {
    revision += 1;
    publishControlSnapshot();
  }

  function assignOldestController(excludedSessionId?: string): void {
    const next = [...connections.values()]
      .filter((connection) => connection.identity.sessionId !== excludedSessionId)
      .sort((left, right) => left.connectedAt.localeCompare(right.connectedAt))[0];
    holderSessionId = next?.identity.sessionId;
  }

  function acceptSocket(socket: Socket): void {
    socket.setEncoding("utf8");
    let body = "";
    let processing = Promise.resolve();

    socket.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maximumFrameBytes) {
        socket.destroy(new Error("Host control frame is too large"));
        return;
      }
      let newline = body.indexOf("\n");
      while (newline >= 0) {
        const line = body.slice(0, newline);
        body = body.slice(newline + 1);
        processing = processing
          .then(() => processLine(socket, line))
          .catch((error) => {
            console.error("SeaShard Host control request failed", error);
          });
        newline = body.indexOf("\n");
      }
    });
    socket.once("close", () => {
      const connection = connections.get(socket);
      if (!connection) return;
      connections.delete(socket);
      const sessionId = connection.identity.sessionId;
      if (pending?.requesterSessionId === sessionId) pending = undefined;
      if (holderSessionId === sessionId) {
        holderSessionId = undefined;
        assignOldestController();
      }
      advanceControlState();
    });
    socket.on("error", () => undefined);
  }

  async function processLine(socket: Socket, line: string): Promise<void> {
    let request: HostControlRequestFrame;
    try {
      request = parseRequest(line);
      const result = await dispatch(socket, request);
      send(socket, {
        type: "response",
        id: request.id,
        ok: true,
        result: result === undefined ? null : result,
        ...(result === undefined ? { resultUndefined: true } : {}),
      });
    } catch (error) {
      const failure = normalizeError(error);
      send(socket, {
        type: "response",
        id: readRequestId(line),
        ok: false,
        code: failure.code,
        error: failure.message,
      });
    }
  }

  async function dispatch(
    socket: Socket,
    request: HostControlRequestFrame,
  ): Promise<JsonValue | void> {
    if (request.action === "hello") return hello(socket, request.payload);
    const connection = connections.get(socket);
    if (!connection) throw rpcError("AUTH_REQUIRED", "Host control hello is required");

    switch (request.action) {
      case "request-control": {
        if (holderSessionId === connection.identity.sessionId)
          return snapshot() as unknown as JsonValue;
        if (!holderSessionId) {
          holderSessionId = connection.identity.sessionId;
          pending = undefined;
          advanceControlState();
          return snapshot() as unknown as JsonValue;
        }
        pending = {
          requestId: randomUUID(),
          requesterSessionId: connection.identity.sessionId,
          requestedAt: new Date().toISOString(),
        };
        advanceControlState();
        const requestSnapshot = snapshot().pending;
        if (requestSnapshot) {
          broadcast("control-requested", requestSnapshot as unknown as JsonValue);
        }
        return snapshot() as unknown as JsonValue;
      }
      case "confirm-control": {
        const requestId = readString(request.payload, "requestId");
        if (!pending || pending.requestId !== requestId) {
          throw rpcError("STALE_CONTROL_REQUEST", "控制权接管请求已经失效");
        }
        if (
          connection.identity.sessionId !== holderSessionId &&
          connection.identity.sessionId !== pending.requesterSessionId
        ) {
          throw rpcError("CONTROL_CONFIRM_FORBIDDEN", "当前控制端无权确认这次接管");
        }
        if (!findBySessionId(pending.requesterSessionId)) {
          pending = undefined;
          advanceControlState();
          throw rpcError("CONTROLLER_DISCONNECTED", "请求接管的控制端已断开");
        }
        holderSessionId = pending.requesterSessionId;
        pending = undefined;
        advanceControlState();
        return snapshot() as unknown as JsonValue;
      }
      case "reject-control": {
        const requestId = readString(request.payload, "requestId");
        if (!pending || pending.requestId !== requestId) {
          throw rpcError("STALE_CONTROL_REQUEST", "控制权接管请求已经失效");
        }
        if (
          connection.identity.sessionId !== holderSessionId &&
          connection.identity.sessionId !== pending.requesterSessionId
        ) {
          throw rpcError("CONTROL_REJECT_FORBIDDEN", "当前控制端无权拒绝这次接管");
        }
        pending = undefined;
        advanceControlState();
        return snapshot() as unknown as JsonValue;
      }
      case "release-control":
        requireHolder(connection);
        holderSessionId = undefined;
        pending = undefined;
        assignOldestController(connection.identity.sessionId);
        advanceControlState();
        return snapshot() as unknown as JsonValue;
      case "service-call": {
        const call = parseServiceCall(request.payload);
        if (options.handlers.isMutation(call)) requireHolder(connection);
        return options.handlers.callService(call);
      }
    }
  }

  function hello(socket: Socket, payload: JsonValue): JsonValue {
    if (connections.has(socket))
      throw rpcError("ALREADY_CONNECTED", "Host control hello was repeated");
    const record = readRecord(payload, "hello payload");
    const receivedToken = readString(record, "token");
    if (!safeTokenEqual(receivedToken, token)) {
      throw rpcError("AUTH_FAILED", "Host control authentication failed");
    }
    const identityRecord = readRecord(record.identity, "controller identity");
    const identity: HostControllerIdentity = {
      sessionId: readString(identityRecord, "sessionId"),
      label: readString(identityRecord, "label"),
    };
    if (findBySessionId(identity.sessionId)) {
      throw rpcError("DUPLICATE_SESSION", "Host controller session already exists");
    }
    connections.set(socket, {
      socket,
      identity,
      connectedAt: new Date().toISOString(),
    });
    if (!holderSessionId) holderSessionId = identity.sessionId;
    advanceControlState();
    return snapshot() as unknown as JsonValue;
  }

  function requireHolder(connection: ControllerConnection): void {
    if (holderSessionId !== connection.identity.sessionId) {
      throw rpcError("CONTROL_REQUIRED", "当前 Controller 没有 Host 写控制权，请先完成接管");
    }
  }

  return {
    descriptor,
    snapshot,
    broadcast(event, payload) {
      broadcast(event, payload);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const connection of connections.values()) connection.socket.destroy();
      connections.clear();
      await close(server);
      await rm(location.descriptorPath, { force: true });
      if (process.platform !== "win32") await rm(location.socketPath, { force: true });
    },
  };
}

function parseRequest(line: string): HostControlRequestFrame {
  const value = JSON.parse(line) as unknown;
  const record = readRecord(value, "Host control frame");
  if (record.type !== "request")
    throw rpcError("INVALID_FRAME", "Host control frame type is invalid");
  const id = readString(record, "id");
  const action = readString(record, "action");
  const actions = new Set([
    "hello",
    "request-control",
    "confirm-control",
    "reject-control",
    "release-control",
    "service-call",
  ]);
  if (!actions.has(action))
    throw rpcError("INVALID_ACTION", `unknown Host control action: ${action}`);
  return {
    type: "request",
    id,
    action: action as HostControlRequestFrame["action"],
    payload: (record.payload ?? null) as JsonValue,
  };
}

function parseServiceCall(value: JsonValue): HostServiceCall {
  const record = readRecord(value, "service call");
  if (!Array.isArray(record.args))
    throw rpcError("INVALID_REQUEST", "service call args must be an array");
  return {
    contract: readString(record, "contract"),
    method: readString(record, "method"),
    args: record.args as JsonValue[],
  };
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw rpcError("INVALID_REQUEST", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | JsonValue, key: string): string {
  const value = (record as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.length === 0) {
    throw rpcError("INVALID_REQUEST", `${key} must be a non-empty string`);
  }
  return value;
}

function safeTokenEqual(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function readRequestId(line: string): string {
  try {
    const value = JSON.parse(line) as { id?: unknown };
    return typeof value.id === "string" ? value.id : "unknown";
  } catch {
    return "unknown";
  }
}

function rpcError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function normalizeError(error: unknown): { code: string; message: string } {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "SeaShard Host call failed";
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return { code: error.code, message };
  }
  return { code: "HOST_CALL_FAILED", message };
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
