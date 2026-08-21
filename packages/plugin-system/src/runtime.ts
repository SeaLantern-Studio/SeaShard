import type {
  ExecutionContext,
  RuntimeControlSnapshot,
  RuntimePluginSnapshot,
} from "@seashard/plugin-sdk";
import type { ResolvedEntry } from "./types";

/**
 * Cordis 之外只保留插件编排所需的最小后端边界。
 *
 * prepare 只读取模块元数据并建立待启动句柄；真正的生命周期由返回的
 * PreparedPlugin.start 创建 Cordis Fiber，stop 则释放该 Fiber 和外部宿主。
 */
export interface PreparedPlugin {
  readonly dependencies: readonly string[];
  readonly provides: readonly string[];
  start(): Promise<RunningPlugin>;
  discard(): Promise<void>;
}

export interface RunningPlugin {
  stop(): Promise<void>;
}

export interface PluginRuntimeAdapter {
  prepare(entry: ResolvedEntry): Promise<PreparedPlugin>;
  dependencyAvailable(contract: string, execution: ExecutionContext): boolean;
}

interface ActivePlugin {
  readonly entry: ResolvedEntry;
  readonly identity: string;
  readonly handle: RunningPlugin;
}

/**
 * 普通桌面插件运行时。
 *
 * 这里不持有持久化运行态，也不实现 Generation、Publication、Lease 或
 * 热切换状态机。插件变更采用停止旧 Fiber、再启动新 Fiber 的简单顺序。
 */
export class PluginRuntime {
  private readonly active = new Map<string, ActivePlugin>();
  private readonly statuses = new Map<string, RuntimePluginSnapshot>();
  private desired = new Map<string, ResolvedEntry>();
  private reconcileTask: Promise<void> = Promise.resolve();
  private stopping = false;

  constructor(
    private readonly backend: PluginRuntimeAdapter,
    private readonly onError?: (error: unknown) => void,
  ) {}

  reconcile(entries: readonly ResolvedEntry[]): Promise<void> {
    const task = this.reconcileTask.then(() => this.reconcileNow(entries));
    this.reconcileTask = task.catch((error) => {
      this.onError?.(error);
    });
    return task;
  }

  async reload(runtimeId: string): Promise<void> {
    const task = this.reconcileTask.then(async () => {
      if (this.stopping) throw new Error("plugin runtime is stopping");
      const current = this.active.get(runtimeId);
      if (!current) throw new Error(`plugin runtime is not active: ${runtimeId}`);
      await this.stopActive(current);
      this.active.delete(runtimeId);
      this.statuses.delete(runtimeId);
      await this.reconcileNow([...this.desired.values()]);
    });
    this.reconcileTask = task.catch((error) => {
      this.onError?.(error);
    });
    return task;
  }

  /** 将外部 Plugin Host 崩溃转换成一次普通的失败状态。 */
  async runtimeFailed(runtimeId: string, error: Error): Promise<void> {
    const current = this.active.get(runtimeId);
    if (!current) return;
    this.active.delete(runtimeId);
    this.statuses.set(runtimeId, snapshotFor(current.entry, "failed", error.message));
  }

  snapshot(): RuntimeControlSnapshot {
    return {
      plugins: [...this.statuses.values()].sort((left, right) =>
        left.runtimeId.localeCompare(right.runtimeId),
      ),
    };
  }

  dispose(): Promise<void> {
    const task = this.reconcileTask.then(async () => {
      this.stopping = true;
      for (const current of [...this.active.values()].reverse()) {
        try {
          await this.stopActive(current);
        } catch (error) {
          this.onError?.(error);
        }
      }
      this.active.clear();
      this.statuses.clear();
      this.desired.clear();
    });
    this.reconcileTask = task.catch((error) => {
      this.onError?.(error);
    });
    return task;
  }

  private async reconcileNow(entries: readonly ResolvedEntry[]): Promise<void> {
    if (this.stopping) throw new Error("plugin runtime is stopping");
    const incoming = new Map(entries.map((entry) => [entry.runtimeId, entry]));
    this.desired = incoming;

    for (const [runtimeId, current] of this.active) {
      const next = incoming.get(runtimeId);
      if (!next || entryIdentity(next) !== current.identity) {
        await this.stopActive(current);
        this.active.delete(runtimeId);
        this.statuses.delete(runtimeId);
      }
    }

    const pending = new Map<string, PreparedPlugin>();
    for (const entry of entries) {
      if (this.active.has(entry.runtimeId)) continue;
      try {
        pending.set(entry.runtimeId, await this.backend.prepare(entry));
      } catch (error) {
        this.statuses.set(
          runtimeIdSnapshot(entry),
          snapshotFor(entry, "failed", formatError(error)),
        );
      }
    }

    while (pending.size) {
      let progress = false;
      for (const [runtimeId, prepared] of pending) {
        const entry = incoming.get(runtimeId);
        if (!entry) {
          await prepared.discard();
          pending.delete(runtimeId);
          continue;
        }
        const execution = createPluginExecution(entry);
        const missing = prepared.dependencies.filter(
          (contract) => !this.backend.dependencyAvailable(contract, execution),
        );
        if (missing.length) continue;

        pending.delete(runtimeId);
        progress = true;
        try {
          const handle = await prepared.start();
          this.active.set(runtimeId, {
            entry,
            identity: entryIdentity(entry),
            handle,
          });
          this.statuses.set(runtimeId, snapshotFor(entry, "active"));
        } catch (error) {
          this.statuses.set(runtimeId, snapshotFor(entry, "failed", formatError(error)));
        }
      }

      if (progress) continue;
      for (const [runtimeId, prepared] of pending) {
        const entry = incoming.get(runtimeId);
        if (!entry) continue;
        await prepared.discard();
        this.statuses.set(
          runtimeId,
          snapshotFor(entry, "failed", "plugin dependencies are unavailable"),
        );
      }
      pending.clear();
    }
  }

  private async stopActive(current: ActivePlugin): Promise<void> {
    await current.handle.stop();
  }
}

export function createPluginExecution(entry: ResolvedEntry): ExecutionContext {
  const ownScope = { type: entry.binding.scopeType, id: entry.binding.scopeId } as const;
  return {
    actorType: "plugin",
    actorId: entry.package.manifest.id,
    runtimeId: entry.runtimeId,
    scopeType: ownScope.type,
    scopeId: ownScope.id,
    scopeChain:
      ownScope.type === "global" ? [ownScope] : [{ type: "global", id: "global" }, ownScope],
    permissions: entry.entry.permissions,
    permissionRevision: 1,
  };
}

function snapshotFor(
  entry: ResolvedEntry,
  state: RuntimePluginSnapshot["state"],
  error?: string,
): RuntimePluginSnapshot {
  return {
    runtimeId: entry.runtimeId,
    pluginId: entry.package.manifest.id,
    pluginVersion: entry.package.manifest.version,
    entryId: entry.entry.id,
    host: entry.host,
    state,
    ...(error ? { error } : {}),
  };
}

function entryIdentity(entry: ResolvedEntry): string {
  return JSON.stringify({
    pluginId: entry.package.manifest.id,
    pluginVersion: entry.package.manifest.version,
    digest: entry.package.digest,
    entryId: entry.entry.id,
    host: entry.host,
    scopeType: entry.binding.scopeType,
    scopeId: entry.binding.scopeId,
    config: entry.binding.config,
  });
}

function runtimeIdSnapshot(entry: ResolvedEntry): string {
  return entry.runtimeId;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
