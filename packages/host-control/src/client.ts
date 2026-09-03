import type {
  AgentActivityPresentationField,
  AgentResourceReadResult,
  JsonValue,
  ServiceContract,
} from "@seashard/plugin-sdk";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { readHostControlDescriptor } from "./location";
import type {
  HostAgentExtensionDirectory,
  HostControlDescriptor,
  HostControlEventFrame,
  HostControlEventName,
  HostControlFrame,
  HostControllerIdentity,
  HostControlRequestFrame,
  HostServiceDescriptor,
  HostControlSnapshot,
} from "./protocol";

const maximumFrameBytes = 8 * 1024 * 1024;
const defaultConnectTimeoutMs = 2_000;

type HostEventListener = (payload: JsonValue) => void;

export class HostControlRpcError extends Error {
  readonly name = "HostControlRpcError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ConnectHostControlClientOptions {
  readonly dataRoot: string;
  readonly identity: HostControllerIdentity;
  readonly timeoutMs?: number;
}

/** 持久 Host 连接；一个实例严格对应一个 Controller 会话。 */
export class HostControlClient {
  private readonly pending = new Map<
    string,
    { resolve(value: JsonValue | undefined): void; reject(error: Error): void }
  >();
  private readonly eventListeners = new Map<HostControlEventName, Set<HostEventListener>>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private body = "";
  private disposed = false;
  private controlSnapshotValue!: HostControlSnapshot;

  private constructor(
    readonly identity: HostControllerIdentity,
    private readonly descriptor: HostControlDescriptor,
    private readonly socket: Socket,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.consume(chunk));
    socket.once("close", () => {
      const error = new Error("SeaShard Host connection closed");
      this.failPending(error);
      for (const listener of this.closeListeners) listener(error);
      this.closeListeners.clear();
    });
    socket.on("error", (error) => this.failPending(error));
    this.on("control-snapshot", (payload) => {
      this.controlSnapshotValue = payload as unknown as HostControlSnapshot;
    });
  }

  static async connect(options: ConnectHostControlClientOptions): Promise<HostControlClient> {
    const descriptor = await readHostControlDescriptor(options.dataRoot);
    if (!descriptor) {
      throw new HostControlRpcError("HOST_UNAVAILABLE", "SeaShard Host descriptor does not exist");
    }
    const socket = await connectSocket(
      descriptor.socketPath,
      options.timeoutMs ?? defaultConnectTimeoutMs,
    );
    const client = new HostControlClient(options.identity, descriptor, socket);
    try {
      client.controlSnapshotValue = (await client.request("hello", {
        token: descriptor.token,
        identity: options.identity,
      } as unknown as JsonValue)) as unknown as HostControlSnapshot;
      return client;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  get controlSnapshot(): HostControlSnapshot {
    return this.controlSnapshotValue;
  }

  get hostVersion(): string | undefined {
    return this.descriptor.seaShardVersion;
  }

  get hostPackageType(): HostControlDescriptor["packageType"] {
    return this.descriptor.packageType;
  }

  get hasControl(): boolean {
    return this.controlSnapshotValue.holder?.sessionId === this.identity.sessionId;
  }

  on(event: HostControlEventName, listener: HostEventListener): () => void {
    const listeners = this.eventListeners.get(event) ?? new Set<HostEventListener>();
    listeners.add(listener);
    this.eventListeners.set(event, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.eventListeners.delete(event);
    };
  }

  onClosed(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  service<TService extends object>(contract: ServiceContract<TService> | string): TService {
    return new Proxy(
      {},
      {
        get: (_target, method) => {
          if (method === "then") return undefined;
          if (typeof method !== "string") return undefined;
          return (...args: JsonValue[]) =>
            this.request("service-call", {
              contract: String(contract),
              method,
              args,
            });
        },
      },
    ) as TService;
  }
  async describeServices(): Promise<readonly HostServiceDescriptor[]> {
    return parseServiceDescriptors(await this.request("describe-services", null));
  }

  async describeAgentExtensions(): Promise<HostAgentExtensionDirectory> {
    return parseAgentExtensionDirectory(await this.request("describe-agent-extensions", null));
  }

  async executeAgentTool(name: string, input: JsonValue): Promise<JsonValue> {
    const result = await this.request("execute-agent-tool", { name, input });
    if (result === undefined) {
      throw new HostControlRpcError(
        "INVALID_AGENT_TOOL_RESULT",
        "Host Agent tool result is missing",
      );
    }
    return result;
  }

  async readAgentResource(path: string, input: JsonValue): Promise<AgentResourceReadResult> {
    const result = await this.request("read-agent-resource", { path, input });
    return parseAgentResourceReadResult(result);
  }

  async presentAgentResourceRequest(
    path: string,
    input: JsonValue,
  ): Promise<readonly AgentActivityPresentationField[] | undefined> {
    return parseAgentPresentationFields(
      await this.request("present-agent-resource-request", { path, input }),
    );
  }

  async presentAgentResourceResult(
    path: string,
    input: JsonValue,
    result: AgentResourceReadResult,
  ): Promise<readonly AgentActivityPresentationField[] | undefined> {
    return parseAgentPresentationFields(
      await this.request("present-agent-resource-result", {
        path,
        input,
        result: result as unknown as JsonValue,
      }),
    );
  }

  async requestControl(): Promise<HostControlSnapshot> {
    const result = (await this.request("request-control", null)) as unknown as HostControlSnapshot;
    this.controlSnapshotValue = result;
    return result;
  }

  async confirmControl(requestId: string): Promise<HostControlSnapshot> {
    const result = (await this.request("confirm-control", {
      requestId,
    })) as unknown as HostControlSnapshot;
    this.controlSnapshotValue = result;
    return result;
  }

  async rejectControl(requestId: string): Promise<HostControlSnapshot> {
    const result = (await this.request("reject-control", {
      requestId,
    })) as unknown as HostControlSnapshot;
    this.controlSnapshotValue = result;
    return result;
  }

  async releaseControl(): Promise<HostControlSnapshot> {
    const result = (await this.request("release-control", null)) as unknown as HostControlSnapshot;
    this.controlSnapshotValue = result;
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.socket.destroy();
    this.failPending(new Error("SeaShard Host controller disposed"));
    this.eventListeners.clear();
    this.closeListeners.clear();
  }

  private request(
    action: HostControlRequestFrame["action"],
    payload: JsonValue,
  ): Promise<JsonValue | undefined> {
    if (this.disposed || this.socket.destroyed) {
      return Promise.reject(
        new HostControlRpcError("HOST_DISCONNECTED", "SeaShard Host is disconnected"),
      );
    }
    const id = randomUUID();
    const frame: HostControlRequestFrame = { type: "request", id, action, payload };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private consume(chunk: string): void {
    this.body += chunk;
    if (Buffer.byteLength(this.body, "utf8") > maximumFrameBytes) {
      this.socket.destroy(new Error("Host control frame is too large"));
      return;
    }
    let newline = this.body.indexOf("\n");
    while (newline >= 0) {
      const line = this.body.slice(0, newline);
      this.body = this.body.slice(newline + 1);
      this.dispatchFrame(JSON.parse(line) as HostControlFrame);
      newline = this.body.indexOf("\n");
    }
  }

  private dispatchFrame(frame: HostControlFrame): void {
    if (frame.type === "event") {
      this.dispatchEvent(frame);
      return;
    }
    if (frame.type !== "response") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok) {
      pending.resolve(frame.resultUndefined ? undefined : frame.result);
    } else {
      pending.reject(new HostControlRpcError(frame.code, frame.error));
    }
  }

  private dispatchEvent(frame: HostControlEventFrame): void {
    for (const listener of this.eventListeners.get(frame.event) ?? []) listener(frame.payload);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export async function connectHostControlClient(
  options: ConnectHostControlClientOptions,
): Promise<HostControlClient> {
  return HostControlClient.connect(options);
}

function parseServiceDescriptors(value: JsonValue | undefined): readonly HostServiceDescriptor[] {
  if (!Array.isArray(value)) {
    throw new HostControlRpcError("INVALID_SERVICE_DIRECTORY", "Host service directory is invalid");
  }
  return value.map((descriptorValue) => {
    if (!descriptorValue || typeof descriptorValue !== "object" || Array.isArray(descriptorValue)) {
      throw new HostControlRpcError(
        "INVALID_SERVICE_DIRECTORY",
        "Host service descriptor is invalid",
      );
    }
    const descriptor = descriptorValue as Record<string, JsonValue>;
    if (
      typeof descriptor.contract !== "string" ||
      !descriptor.contract ||
      !Array.isArray(descriptor.methods)
    ) {
      throw new HostControlRpcError(
        "INVALID_SERVICE_DIRECTORY",
        "Host service descriptor is invalid",
      );
    }
    const methods = descriptor.methods.map((method) => {
      if (typeof method !== "string" || !method) {
        throw new HostControlRpcError(
          "INVALID_SERVICE_DIRECTORY",
          "Host service descriptor is invalid",
        );
      }
      return method;
    });
    return {
      contract: descriptor.contract,
      methods: [...new Set(methods)].sort((left, right) => left.localeCompare(right)),
    };
  });
}

function parseAgentExtensionDirectory(value: JsonValue | undefined): HostAgentExtensionDirectory {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostControlRpcError(
      "INVALID_AGENT_EXTENSION_DIRECTORY",
      "Host Agent extension directory is invalid",
    );
  }
  if (!Array.isArray(value.tools) || !Array.isArray(value.resources)) {
    throw new HostControlRpcError(
      "INVALID_AGENT_EXTENSION_DIRECTORY",
      "Host Agent extension directory is invalid",
    );
  }
  const tools = value.tools.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.name !== "string" ||
      !item.name ||
      !item.definition ||
      typeof item.definition !== "object" ||
      Array.isArray(item.definition)
    ) {
      throw new HostControlRpcError(
        "INVALID_AGENT_EXTENSION_DIRECTORY",
        "Host Agent tool descriptor is invalid",
      );
    }
    return {
      name: item.name,
      definition: item.definition,
    };
  });
  const resources = value.resources.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.pattern !== "string" ||
      !item.pattern
    ) {
      throw new HostControlRpcError(
        "INVALID_AGENT_EXTENSION_DIRECTORY",
        "Host Agent resource descriptor is invalid",
      );
    }
    return item;
  });
  return {
    tools: tools as unknown as HostAgentExtensionDirectory["tools"],
    resources: resources as unknown as HostAgentExtensionDirectory["resources"],
  };
}

function parseAgentResourceReadResult(value: JsonValue | undefined): AgentResourceReadResult {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.mimeType !== "string" ||
    !value.mimeType ||
    !Object.hasOwn(value, "content")
  ) {
    throw new HostControlRpcError(
      "INVALID_AGENT_RESOURCE_RESULT",
      "Host Agent resource result is invalid",
    );
  }
  return value as unknown as AgentResourceReadResult;
}

function parseAgentPresentationFields(
  value: JsonValue | undefined,
): readonly AgentActivityPresentationField[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new HostControlRpcError(
      "INVALID_AGENT_PRESENTATION",
      "Host Agent resource presentation is invalid",
    );
  }
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.value !== "string"
    ) {
      throw new HostControlRpcError(
        "INVALID_AGENT_PRESENTATION",
        "Host Agent resource presentation is invalid",
      );
    }
  }
  return value as unknown as readonly AgentActivityPresentationField[];
}

function connectSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new HostControlRpcError("HOST_CONNECT_TIMEOUT", "SeaShard Host connection timed out"));
    }, timeoutMs);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(socket);
    });
    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
  });
}
