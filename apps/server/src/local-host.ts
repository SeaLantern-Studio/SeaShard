import {
  serverRuntimeContract,
  type ServerConsoleLine,
  type ServerInstanceSnapshot,
  type ServerRuntimeService,
  type ServerRuntimeSnapshot,
} from "@seashard/contracts";
import {
  connectHostControlClient,
  type HostAgentExtensionDirectory,
  type HostControlClient,
  type HostControllerIdentity,
  type HostControlRequestSnapshot,
  type HostControllerSnapshot,
  type HostServiceDescriptor,
} from "@seashard/host-control";
import type {
  AgentActivityPresentationField,
  AgentResourceReadResult,
  JsonValue,
  ServiceProvider,
} from "@seashard/plugin-sdk";
import {
  serverInstanceManagerContract,
  type ServerInstanceManagerService,
} from "@seashard/server-instance-manager";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export interface ConnectServerLocalHostOptions {
  readonly dataRoot: string;
  readonly identity?: HostControllerIdentity;
}

export interface ServerLocalHostSnapshot {
  readonly id: "local";
  readonly revision: number;
  readonly controllerSessionId: string;
  readonly holder?: HostControllerSnapshot;
  readonly pending?: HostControlRequestSnapshot;
  readonly hasControl: boolean;
  readonly hostVersion?: string;
  readonly packageType?: string;
  readonly connectedControllers: number;
}

/**
 * Server Controller 第一版的本机 Host 会话。所有服务器进程调用都经过 Host Control RPC；
 * dispose 只断开 Controller socket，绝不停止 Host 或正在运行的 Minecraft 进程。
 */
export class ServerLocalHostConnection {
  private readonly instances: ServerInstanceManagerService;
  private readonly runtime: ServerRuntimeService;
  private disposed = false;

  private constructor(private readonly client: HostControlClient) {
    this.instances = client.service<ServerInstanceManagerService>(serverInstanceManagerContract);
    this.runtime = client.service<ServerRuntimeService>(serverRuntimeContract);
  }

  static async connect(options: ConnectServerLocalHostOptions): Promise<ServerLocalHostConnection> {
    const identity =
      options.identity ??
      ({
        sessionId: randomUUID(),
        label: `${hostname()} · Server ${process.pid}`,
      } satisfies HostControllerIdentity);
    return new ServerLocalHostConnection(
      await connectHostControlClient({ dataRoot: options.dataRoot, identity }),
    );
  }

  snapshot(): ServerLocalHostSnapshot {
    const control = this.client.controlSnapshot;
    return {
      id: "local",
      hasControl: this.client.hasControl,
      connectedControllers: control.controllers.length,
      revision: control.revision,
      controllerSessionId: this.client.identity.sessionId,
      ...(control.holder ? { holder: control.holder } : {}),
      ...(control.pending ? { pending: control.pending } : {}),
      ...(this.client.hostVersion ? { hostVersion: this.client.hostVersion } : {}),
      ...(this.client.hostPackageType ? { packageType: this.client.hostPackageType } : {}),
    };
  }

  requestControl(): Promise<unknown> {
    this.assertConnected();
    return this.client.requestControl();
  }

  confirmControl(requestId: string): Promise<unknown> {
    this.assertConnected();
    return this.client.confirmControl(requestId);
  }

  rejectControl(requestId: string): Promise<unknown> {
    this.assertConnected();
    return this.client.rejectControl(requestId);
  }

  releaseControl(): Promise<unknown> {
    this.assertConnected();
    return this.client.releaseControl();
  }
  /** Host Worker 部署器复用同一条已认证控制连接，不另建会话或争抢控制权。 */
  workerDeploymentClient(): HostControlClient {
    this.assertConnected();
    return this.client;
  }
  describeServices(): Promise<readonly HostServiceDescriptor[]> {
    this.assertConnected();
    return this.client.describeServices();
  }
  describeAgentExtensions(): Promise<HostAgentExtensionDirectory> {
    this.assertConnected();
    return this.client.describeAgentExtensions();
  }

  executeAgentTool(name: string, input: JsonValue): Promise<JsonValue> {
    this.assertConnected();
    return this.client.executeAgentTool(name, input);
  }

  readAgentResource(path: string, input: JsonValue): Promise<AgentResourceReadResult> {
    this.assertConnected();
    return this.client.readAgentResource(path, input);
  }

  presentAgentResourceRequest(
    path: string,
    input: JsonValue,
  ): Promise<readonly AgentActivityPresentationField[] | undefined> {
    this.assertConnected();
    return this.client.presentAgentResourceRequest(path, input);
  }

  presentAgentResourceResult(
    path: string,
    input: JsonValue,
    result: AgentResourceReadResult,
  ): Promise<readonly AgentActivityPresentationField[] | undefined> {
    this.assertConnected();
    return this.client.presentAgentResourceResult(path, input, result);
  }

  async callService(
    contract: string,
    method: string,
    args: readonly JsonValue[],
  ): Promise<JsonValue | void> {
    this.assertConnected();
    const target = this.client.service<ServiceProvider>(contract)[method];
    if (!target) throw new Error(`Host Service 方法不存在：${contract}.${method}`);
    return await target(...args);
  }

  listInstances(): Promise<readonly ServerInstanceSnapshot[]> {
    this.assertConnected();
    return this.instances.list();
  }

  getRuntime(instanceId: string): Promise<ServerRuntimeSnapshot> {
    this.assertConnected();
    return this.runtime.get(instanceId);
  }

  start(instanceId: string): Promise<ServerRuntimeSnapshot> {
    this.assertConnected();
    return this.runtime.start(instanceId);
  }

  waitUntilStartupSettled(
    instanceId: string,
    timeoutMilliseconds: number,
  ): Promise<ServerRuntimeSnapshot> {
    this.assertConnected();
    return this.runtime.waitUntilStartupSettled(instanceId, timeoutMilliseconds);
  }

  sendCommand(instanceId: string, command: string): Promise<void> {
    this.assertConnected();
    return this.runtime.sendCommand(instanceId, command);
  }

  getLogs(instanceId: string, afterSequence?: number): Promise<readonly ServerConsoleLine[]> {
    this.assertConnected();
    return afterSequence === undefined
      ? this.runtime.getLogs(instanceId)
      : this.runtime.getLogs(instanceId, afterSequence);
  }

  stop(instanceId: string): Promise<ServerRuntimeSnapshot> {
    this.assertConnected();
    return this.runtime.stop(instanceId);
  }

  waitUntilStopped(
    instanceId: string,
    timeoutMilliseconds: number,
  ): Promise<ServerRuntimeSnapshot> {
    this.assertConnected();
    return this.runtime.waitUntilStopped(instanceId, timeoutMilliseconds);
  }

  async restart(instanceId: string, timeoutMilliseconds: number): Promise<ServerRuntimeSnapshot> {
    this.assertConnected();
    const current = await this.runtime.get(instanceId);
    if (current.state !== "stopped" && current.state !== "failed") {
      await this.runtime.stop(instanceId);
      await this.runtime.waitUntilStopped(instanceId, timeoutMilliseconds);
    }
    await this.runtime.start(instanceId);
    return this.runtime.waitUntilStartupSettled(instanceId, timeoutMilliseconds);
  }

  onConsoleLine(listener: (line: ServerConsoleLine) => void): () => void {
    this.assertConnected();
    return this.client.on("server-console", (payload) => listener(parseConsoleLine(payload)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.client.dispose();
  }

  private assertConnected(): void {
    if (this.disposed) throw new Error("Server Controller 已断开本机 Host");
  }
}

function parseConsoleLine(value: unknown): ServerConsoleLine {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Host server console event must be an object");
  }
  const line = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(line.sequence) ||
    (line.sequence as number) < 1 ||
    typeof line.instanceId !== "string" ||
    !line.instanceId ||
    (line.stream !== "stdout" &&
      line.stream !== "stderr" &&
      line.stream !== "input" &&
      line.stream !== "system") ||
    typeof line.text !== "string" ||
    typeof line.timestamp !== "string"
  ) {
    throw new TypeError("Host server console event is invalid");
  }
  return line as unknown as ServerConsoleLine;
}
