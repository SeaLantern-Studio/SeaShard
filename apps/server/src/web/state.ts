import type {
  ServerConsoleLine,
  ServerInstanceSnapshot,
  ServerRuntimeSnapshot,
} from "@seashard/contracts";
import {
  serverWebApiVersion,
  type ServerWebEvent,
  type ServerWebEventEnvelope,
  type ServerWebHostSnapshot,
  type ServerWebInstanceSnapshot,
  type ServerWebStateSnapshot,
  type ServerWebTaskKind,
  type ServerWebTaskSnapshot,
} from "@seashard/server-web-api";
import type { ServerLocalHostSnapshot } from "../local-host";
import { randomUUID } from "node:crypto";

const maximumEvents = 512;
const maximumTasks = 100;
const runtimeOperationTimeoutMilliseconds = 60_000;

type EventListener = (event: ServerWebEventEnvelope) => void;
export interface ServerWebHostSource {
  snapshot(): ServerLocalHostSnapshot;
  listInstances(): Promise<readonly ServerInstanceSnapshot[]>;
  getRuntime(instanceId: string): Promise<ServerRuntimeSnapshot>;
  start(instanceId: string): Promise<ServerRuntimeSnapshot>;
  waitUntilStartupSettled(
    instanceId: string,
    timeoutMilliseconds: number,
  ): Promise<ServerRuntimeSnapshot>;
  stop(instanceId: string): Promise<ServerRuntimeSnapshot>;
  waitUntilStopped(instanceId: string, timeoutMilliseconds: number): Promise<ServerRuntimeSnapshot>;
  restart(instanceId: string, timeoutMilliseconds: number): Promise<ServerRuntimeSnapshot>;
  sendCommand(instanceId: string, command: string): Promise<void>;
  getLogs(instanceId: string, afterSequence?: number): Promise<readonly ServerConsoleLine[]>;
  onConsoleLine(listener: (line: ServerConsoleLine) => void): () => void;
}

/** 汇集 Host 事实、服务器任务和实时日志，HTTP 层只负责鉴权与传输。 */
export class ServerWebStateCoordinator {
  private readonly listeners = new Set<EventListener>();
  private readonly events: ServerWebEventEnvelope[] = [];
  private readonly tasks: ServerWebTaskSnapshot[] = [];
  private readonly stopConsole?: () => void;
  private sequence = 0;
  private disposed = false;

  constructor(private readonly host: ServerWebHostSource | undefined) {
    this.stopConsole = host?.onConsoleLine((line) => {
      this.publish({ type: "console-line", line });
    });
  }

  async snapshot(): Promise<ServerWebStateSnapshot> {
    const host = this.host;
    const hostSnapshot: ServerWebHostSnapshot = host
      ? { ...host.snapshot(), connected: true }
      : {
          id: "local",
          connected: false,
          hasControl: false,
          connectedControllers: 0,
        };
    const instances = host ? await host.listInstances() : [];
    const runtimes = await Promise.all(
      instances.map(async ({ id }) => {
        try {
          return await host!.getRuntime(id);
        } catch (error) {
          return {
            instanceId: id,
            state: "failed",
            error: errorMessage(error),
          } satisfies ServerRuntimeSnapshot;
        }
      }),
    );
    return {
      apiVersion: serverWebApiVersion,
      generatedAt: new Date().toISOString(),
      host: hostSnapshot,
      instances: instances.map(
        (instance, index) =>
          ({
            id: instance.id,
            name: instance.name,
            storageMode: instance.storageMode,
            source: instance.source,
            ...(instance.serverType ? { serverType: instance.serverType } : {}),
            ...(instance.gameVersion ? { gameVersion: instance.gameVersion } : {}),
            createdAt: instance.createdAt,
            updatedAt: instance.updatedAt,
            ...(instance.lastStartedAt ? { lastStartedAt: instance.lastStartedAt } : {}),
            ...(instance.totalRuntimeMs === undefined
              ? {}
              : { totalRuntimeMs: instance.totalRuntimeMs }),
            runtime: runtimes[index]!,
          }) satisfies ServerWebInstanceSnapshot,
      ),
      tasks: this.tasks.slice(),
    };
  }

  recentEvents(afterSequence: number): readonly ServerWebEventEnvelope[] {
    return this.events.filter(({ sequence }) => sequence > afterSequence);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publishState(): Promise<ServerWebEventEnvelope> {
    return this.publish({ type: "state", state: await this.snapshot() });
  }

  startTask(kind: ServerWebTaskKind, instanceId: string): ServerWebTaskSnapshot {
    this.requireHost();
    const task: ServerWebTaskSnapshot = {
      id: randomUUID(),
      kind,
      instanceId: requireInstanceId(instanceId),
      state: "running",
      createdAt: new Date().toISOString(),
    };
    this.tasks.unshift(task);
    if (this.tasks.length > maximumTasks) this.tasks.length = maximumTasks;
    this.publish({ type: "task", task });
    void this.runTask(task).catch(() => undefined);
    return task;
  }

  async sendCommand(instanceId: string, command: string): Promise<void> {
    const host = this.requireHost();
    await host.sendCommand(requireInstanceId(instanceId), requireCommand(command));
  }

  getLogs(instanceId: string, afterSequence: number): Promise<readonly ServerConsoleLine[]> {
    return this.requireHost().getLogs(
      requireInstanceId(instanceId),
      requireSequence(afterSequence),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopConsole?.();
    this.listeners.clear();
  }

  private async runTask(task: ServerWebTaskSnapshot): Promise<void> {
    const host = this.requireHost();
    let result: ServerRuntimeSnapshot;
    try {
      if (task.kind === "start") {
        await host.start(task.instanceId);
        result = await host.waitUntilStartupSettled(
          task.instanceId,
          runtimeOperationTimeoutMilliseconds,
        );
      } else if (task.kind === "stop") {
        await host.stop(task.instanceId);
        result = await host.waitUntilStopped(task.instanceId, runtimeOperationTimeoutMilliseconds);
      } else {
        result = await host.restart(task.instanceId, runtimeOperationTimeoutMilliseconds);
      }
      this.replaceTask({
        ...task,
        state: "succeeded",
        completedAt: new Date().toISOString(),
        resultState: result.state,
      });
    } catch (error) {
      this.replaceTask({
        ...task,
        state: "failed",
        completedAt: new Date().toISOString(),
        error: errorMessage(error),
      });
    }
    await this.publishState().catch(() => undefined);
  }

  private replaceTask(task: ServerWebTaskSnapshot): void {
    const index = this.tasks.findIndex(({ id }) => id === task.id);
    if (index >= 0) this.tasks[index] = task;
    this.publish({ type: "task", task });
  }

  private publish(event: ServerWebEvent): ServerWebEventEnvelope {
    const envelope = { sequence: ++this.sequence, event };
    this.events.push(envelope);
    if (this.events.length > maximumEvents)
      this.events.splice(0, this.events.length - maximumEvents);
    for (const listener of this.listeners) listener(envelope);
    return envelope;
  }

  private requireHost(): ServerWebHostSource {
    if (!this.host) throw new WebStateError("HOST_UNAVAILABLE", "本机 Host 当前不可用");
    return this.host;
  }
}

export class WebStateError extends Error {
  readonly name = "WebStateError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function requireInstanceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw new WebStateError("INVALID_INSTANCE", "服务器实例 ID 无效");
  }
  return value;
}

function requireSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WebStateError("INVALID_SEQUENCE", "控制台日志序号无效");
  }
  return value as number;
}

function requireCommand(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4_096 ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new WebStateError("INVALID_COMMAND", "服务器命令无效");
  }
  return value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
