import type { PreparedPlugin, RunningPlugin } from "./runtime";
import type {
  ExecutionContext,
  JsonValue,
  PluginContext,
  PluginModule,
  PluginStorageBroker,
  ScopeAddress,
  ServiceProvider,
} from "@seashard/plugin-sdk";
import { Context, type Fiber } from "cordis";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ContributionRegistrationPayload,
  EventDispatchPayload,
  EventRegistrationPayload,
  HostProtocolMessage,
  PreparedRuntimePayload,
  PrepareRuntimePayload,
  ProtocolRequest,
  ProviderInvocationPayload,
  ServiceCallPayload,
  ServiceRegistrationPayload,
  ServiceUnregistrationPayload,
  StorageDeletePayload,
  StorageGetPayload,
  StoragePutPayload,
} from "./host-protocol";
import { PluginRegistry } from "./registry";
import { ContributionRegistry, PluginEventBus, ServiceRegistry } from "./runtime-registries";
import type { ResolvedEntry } from "./types";

interface RuntimeRegistries {
  services: ServiceRegistry;
  contributions: ContributionRegistry;
  events: PluginEventBus;
  storage: PluginStorageBroker;
}

/**
 * 将插件包转换成 Cordis Fiber 或独立 Plugin Host 的运行句柄。
 *
 * 该后端只负责模块装载和资源释放，不维护持久化运行态。
 */
export class PluginRuntimeBackend {
  constructor(
    private readonly root: Context,
    private readonly registry: PluginRegistry,
    private readonly registries: RuntimeRegistries,
    private readonly pluginHostEntry: string,
    private readonly onHostFailure?: (runtimeId: string, error: Error) => void,
  ) {}

  prepare(entry: ResolvedEntry): Promise<PreparedPlugin> {
    if (entry.host === "core") return this.prepareBuiltIn(entry);
    if (entry.host === "node-plugin-host") return this.prepareExternal(entry);
    throw new Error(`client entry requires a connected client runtime: ${entry.runtimeId}`);
  }

  dependencyAvailable(contract: string, execution: ExecutionContext): boolean {
    return this.registries.services.has(contract, execution);
  }

  private async prepareBuiltIn(entry: ResolvedEntry): Promise<PreparedPlugin> {
    const loader = this.registry.getBuiltInLoader(entry.package.manifest.id, entry.entry.id);
    if (!loader) throw new Error(`built-in module loader is missing: ${entry.runtimeId}`);
    const module = validatePluginModule(await loader.load());
    const config = await validateConfig(module, entry.binding.config);
    const dependencies = validateContracts(module.inject ?? [], "inject");
    const provides = validateContracts(module.provides ?? [], "provides");
    const execution = createPluginExecution(entry);
    const registries = this.registries;
    let consumed = false;

    return {
      dependencies,
      provides,
      start: async () => {
        if (consumed) throw new Error(`prepared runtime already consumed: ${entry.runtimeId}`);
        consumed = true;
        const adapter = {
          name: entry.runtimeId,
          async apply(cordisContext: Context) {
            const pluginContext = createLocalPluginContext(
              cordisContext,
              entry,
              execution,
              registries,
            );
            const cleanup = await module.apply(pluginContext, config);
            if (cleanup) cordisContext.effect(() => cleanup, "plugin module cleanup");
          },
        };
        const fiber = this.root.plugin(adapter);
        try {
          await fiber;
          return new LocalRuntimeHandle(fiber, entry.runtimeId, registries);
        } catch (error) {
          await fiber.dispose();
          removeRuntimeRegistrations(registries, entry.runtimeId);
          throw error;
        }
      },
      discard: async () => {
        consumed = true;
      },
    };
  }

  private async prepareExternal(entry: ResolvedEntry): Promise<PreparedPlugin> {
    const execution = createPluginExecution(entry);
    const session = new PluginHostSession(
      this.pluginHostEntry,
      entry,
      execution,
      this.registries,
      (error) => this.onHostFailure?.(entry.runtimeId, error),
    );
    try {
      const modulePath = join(entry.package.rootPath, entry.entry.module.slice(2));
      const moduleUrl = pathToFileURL(modulePath);
      moduleUrl.searchParams.set("runtime", entry.runtimeId);
      const prepared = (await session.request("prepare", {
        moduleUrl: moduleUrl.href,
        config: entry.binding.config,
        runtimeId: entry.runtimeId,
        execution,
      } satisfies PrepareRuntimePayload)) as unknown as PreparedRuntimePayload;
      let consumed = false;
      return {
        dependencies: prepared.dependencies,
        provides: prepared.provides,
        start: async () => {
          if (consumed) throw new Error(`prepared runtime already consumed: ${entry.runtimeId}`);
          consumed = true;
          try {
            await session.request("start", null);
            return new ExternalRuntimeHandle(session, entry.runtimeId, this.registries);
          } catch (error) {
            await session.close();
            throw error;
          }
        },
        discard: async () => {
          if (consumed) return;
          consumed = true;
          await session.close();
        },
      };
    } catch (error) {
      await session.close();
      throw error;
    }
  }
}

class LocalRuntimeHandle implements RunningPlugin {
  constructor(
    private readonly fiber: Fiber,
    private readonly runtimeId: string,
    private readonly registries: RuntimeRegistries,
  ) {}

  async stop(): Promise<void> {
    try {
      await this.fiber.dispose();
    } finally {
      removeRuntimeRegistrations(this.registries, this.runtimeId);
    }
  }
}

class ExternalRuntimeHandle implements RunningPlugin {
  constructor(
    private readonly session: PluginHostSession,
    private readonly runtimeId: string,
    private readonly registries: RuntimeRegistries,
  ) {}

  async stop(): Promise<void> {
    try {
      await this.session.request("stop", null);
    } finally {
      removeRuntimeRegistrations(this.registries, this.runtimeId);
      await this.session.close();
    }
  }
}

class PluginHostSession {
  private readonly child: ChildProcess;
  private readonly pending = new Map<
    string,
    {
      resolve(value: JsonValue | undefined): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly registrationDisposers = new Map<string, () => void>();
  private requestCounter = 0;
  private expectedExit = false;
  private closeTask?: Promise<void>;

  constructor(
    pluginHostEntry: string,
    private readonly entry: ResolvedEntry,
    private readonly execution: ExecutionContext,
    private readonly registries: RuntimeRegistries,
    private readonly onUnexpectedExit: (error: Error) => void,
  ) {
    this.child = spawn(process.execPath, [pluginHostEntry], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.child.on("message", (message) => {
      void this.receive(message as HostProtocolMessage);
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) => {
      const detail = code === null ? `signal ${signal}` : `code ${code}`;
      const error = new Error(`plugin host ${this.entry.runtimeId} exited with ${detail}`);
      this.fail(error);
      if (!this.expectedExit) this.onUnexpectedExit(error);
    });
  }

  request(command: string, payload: unknown): Promise<JsonValue | undefined> {
    if (!this.child.connected) return Promise.reject(new Error("plugin host IPC is disconnected"));
    const id = `parent:${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`plugin host request timed out: ${command}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: "request", id, command, payload: payload as JsonValue });
    });
  }

  close(): Promise<void> {
    this.closeTask ??= this.closeProcess();
    return this.closeTask;
  }

  private async receive(message: HostProtocolMessage): Promise<void> {
    if (message.type === "response") {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message.value);
      else request.reject(new Error(message.error ?? "plugin host request failed"));
      return;
    }
    if (message.type === "request") {
      await this.receiveRequest(message);
      return;
    }
    this.receiveNotification(message.event, message.payload);
  }

  private async receiveRequest(message: ProtocolRequest): Promise<void> {
    try {
      let value: JsonValue | undefined;
      if (message.command === "call-service") {
        const payload = message.payload as unknown as ServiceCallPayload;
        const result = await this.registries.services.call(
          payload.contract,
          payload.method,
          payload.args,
          payload.execution,
        );
        value = result === undefined ? undefined : result;
      } else if (message.command === "emit-event") {
        const payload = message.payload as unknown as {
          event: string;
          payload: JsonValue;
          execution: ExecutionContext;
        };
        await this.registries.events.emit(payload.event, payload.payload, payload.execution);
      } else if (message.command === "storage-get") {
        const payload = message.payload as unknown as StorageGetPayload;
        const result = await this.registries.storage.for(this.execution).get(payload.key);
        value = result as unknown as JsonValue | undefined;
      } else if (message.command === "storage-put") {
        const payload = message.payload as unknown as StoragePutPayload;
        const result = await this.registries.storage
          .for(this.execution)
          .put(payload.key, payload.value, payload.options);
        value = result as unknown as JsonValue;
      } else if (message.command === "storage-delete") {
        const payload = message.payload as unknown as StorageDeletePayload;
        value = await this.registries.storage
          .for(this.execution)
          .delete(payload.key, payload.options);
      } else {
        throw new Error(`unknown child request: ${message.command}`);
      }
      this.send({
        type: "response",
        id: message.id,
        ok: true,
        ...(value === undefined ? {} : { value }),
      });
    } catch (error) {
      this.send({ type: "response", id: message.id, ok: false, error: formatError(error) });
    }
  }

  private receiveNotification(event: string, payload: JsonValue): void {
    switch (event) {
      case "service-register":
        this.registerService(payload as unknown as ServiceRegistrationPayload);
        break;
      case "service-unregister":
      case "contribution-unregister":
      case "event-unregister":
        this.removeRegistration(payload as unknown as ServiceUnregistrationPayload);
        break;
      case "contribution-register":
        this.registerContribution(payload as unknown as ContributionRegistrationPayload);
        break;
      case "event-register":
        this.registerEvent(payload as unknown as EventRegistrationPayload);
        break;
      default:
        throw new Error(`unknown plugin host notification: ${event}`);
    }
  }

  private registerService(payload: ServiceRegistrationPayload): void {
    const provider = Object.create(null) as ServiceProvider;
    if (payload.methods.some((method) => !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(method))) {
      throw new TypeError(`plugin service contains an invalid method name: ${payload.contract}`);
    }
    for (const method of payload.methods) {
      provider[method] = (...args) =>
        this.request("invoke-provider", {
          registrationId: payload.registrationId,
          method,
          args,
        } satisfies ProviderInvocationPayload);
    }
    const dispose = this.registries.services.register(
      payload.contract,
      this.entry.runtimeId,
      scopeFor(this.entry),
      provider,
    );
    this.registrationDisposers.set(payload.registrationId, dispose);
  }

  private registerContribution(payload: ContributionRegistrationPayload): void {
    const registration = this.registries.contributions.register(
      payload.kind,
      this.entry.runtimeId,
      scopeFor(this.entry),
      payload.value,
    );
    this.registrationDisposers.set(payload.registrationId, registration.dispose);
  }

  private registerEvent(payload: EventRegistrationPayload): void {
    const dispose = this.registries.events.on(
      payload.event,
      this.entry.runtimeId,
      scopeFor(this.entry),
      async (eventPayload) => {
        await this.request("dispatch-event", {
          registrationId: payload.registrationId,
          payload: eventPayload,
        } satisfies EventDispatchPayload);
      },
    );
    this.registrationDisposers.set(payload.registrationId, dispose);
  }

  private removeRegistration(payload: ServiceUnregistrationPayload): void {
    this.registrationDisposers.get(payload.registrationId)?.();
    this.registrationDisposers.delete(payload.registrationId);
  }

  private send(message: HostProtocolMessage): void {
    if (!this.child.send) throw new Error("plugin host IPC channel is unavailable");
    this.child.send(message);
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const dispose of this.registrationDisposers.values()) dispose();
    this.registrationDisposers.clear();
    removeRuntimeRegistrations(this.registries, this.entry.runtimeId);
  }

  private closeProcess(): Promise<void> {
    this.expectedExit = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.fail(new Error("plugin host closed"));
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.child.kill(), 2_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (this.child.connected) {
        this.child.send({ type: "notification", event: "terminate", payload: null });
      } else {
        this.child.kill();
      }
    });
  }
}

function createLocalPluginContext(
  cordisContext: Context,
  entry: ResolvedEntry,
  execution: ExecutionContext,
  registries: RuntimeRegistries,
): PluginContext {
  const scope = scopeFor(entry);
  return {
    execution,
    runtimeId: entry.runtimeId,
    storage: registries.storage.for(execution),
    effect(execute, label) {
      cordisContext.effect(async () => (await execute()) ?? (() => {}), label);
    },
    provide(contract, provider) {
      cordisContext.effect(
        () => registries.services.register(contract, entry.runtimeId, scope, provider),
        `service ${contract}`,
      );
    },
    service<T extends object>(contract: string): T {
      return new Proxy(
        {},
        {
          get(_target, property) {
            if (property === "then") return undefined;
            if (typeof property !== "string") return undefined;
            return (...args: JsonValue[]) =>
              registries.services.call(contract, property, args, execution);
          },
        },
      ) as T;
    },
    contribute(kind, value) {
      const registration = registries.contributions.register(kind, entry.runtimeId, scope, value);
      cordisContext.effect(() => registration.dispose, `contribution ${kind}`);
      return registration.id;
    },
    on(event, handler) {
      cordisContext.effect(
        () => registries.events.on(event, entry.runtimeId, scope, handler),
        `event ${event}`,
      );
    },
    emit(event, payload) {
      return registries.events.emit(event, payload, execution);
    },
  };
}

function createPluginExecution(entry: ResolvedEntry): ExecutionContext {
  const ownScope = scopeFor(entry);
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

function scopeFor(entry: ResolvedEntry): ScopeAddress {
  return { type: entry.binding.scopeType, id: entry.binding.scopeId };
}

function removeRuntimeRegistrations(registries: RuntimeRegistries, runtimeId: string): void {
  registries.services.removeRuntime(runtimeId);
  registries.contributions.removeRuntime(runtimeId);
  registries.events.removeRuntime(runtimeId);
}

function validatePluginModule(value: unknown): PluginModule {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as Partial<PluginModule>).apply !== "function"
  ) {
    throw new TypeError("plugin module must export apply(ctx, config)");
  }
  return value as PluginModule;
}

async function validateConfig(module: PluginModule, config: JsonValue): Promise<JsonValue> {
  if (!module.Config) return config;
  const result = await module.Config["~standard"].validate(config);
  if (result.issues?.length) {
    throw new TypeError(
      `plugin config is invalid: ${result.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return (result.value ?? config) as JsonValue;
}

function validateContracts(values: readonly string[], exportName: string): string[] {
  const result = [...new Set(values)];
  if (result.some((value) => !/^[a-z0-9][a-z0-9.*:-]*$/.test(value))) {
    throw new TypeError(`plugin ${exportName} contains an invalid contract identifier`);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
