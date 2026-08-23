import type {
  AgentToolDefinition,
  AgentToolExecutionContext,
  AgentToolHandler,
  Awaitable,
  ExecutionContext,
  JsonObject,
  JsonValue,
  ScopeAddress,
  ServiceProvider,
} from "@seashard/plugin-sdk";

interface ServiceRegistration {
  contract: string;
  runtimeId: string;
  scope: ScopeAddress;
  provider: ServiceProvider;
}

interface ContributionRegistration {
  id: string;
  kind: string;
  runtimeId: string;
  scope: ScopeAddress;
  value: JsonValue;
}

interface EventRegistration {
  event: string;
  runtimeId: string;
  scope: ScopeAddress;
  handler: (payload: JsonValue) => Awaitable<void>;
}

interface AgentToolRegistration {
  readonly id: string;
  readonly runtimeId: string;
  readonly scope: ScopeAddress;
  readonly name: string;
  readonly definition: AgentToolDefinition;
  readonly handler: AgentToolHandler;
  active: boolean;
}

export interface AgentToolSnapshot {
  readonly name: string;
  readonly definition: AgentToolDefinition;
  execute(input: JsonValue, context: AgentToolExecutionContext): Promise<JsonValue>;
}
export interface ContributionSnapshot {
  id: string;
  kind: string;
  runtimeId: string;
  scope: ScopeAddress;
  value: JsonValue;
}

/**
 * 运行时注册表只保存当前 Cordis Fiber 的公开内容。
 *
 * 注册随着 Fiber 的 effect 自动撤销，不再复制 Publication、Lease 或
 * Generation 状态，也不把运行态写入数据库。
 */
export class ServiceRegistry {
  private readonly registrations = new Map<string, Set<ServiceRegistration>>();

  register(
    contract: string,
    runtimeId: string,
    scope: ScopeAddress,
    provider: ServiceProvider,
  ): () => void {
    validateContract(contract);
    const methods = Object.entries(provider);
    if (methods.length === 0 || methods.some(([, method]) => typeof method !== "function")) {
      throw new TypeError(`service provider ${contract} must expose callable methods`);
    }
    const registration: ServiceRegistration = { contract, runtimeId, scope, provider };
    let set = this.registrations.get(contract);
    if (!set) {
      set = new Set();
      this.registrations.set(contract, set);
    }
    if (
      [...set].some(
        (candidate) =>
          candidate.runtimeId === runtimeId &&
          candidate.scope.type === scope.type &&
          candidate.scope.id === scope.id,
      )
    ) {
      throw new Error(
        `service ${contract} is already registered by ${runtimeId} in ${scope.type}:${scope.id}`,
      );
    }
    set.add(registration);
    return () => {
      set?.delete(registration);
      if (set?.size === 0) this.registrations.delete(contract);
    };
  }

  has(contract: string, execution?: ExecutionContext): boolean {
    const set = this.registrations.get(contract);
    if (!set) return false;
    return execution ? this.select(contract, execution) !== undefined : set.size > 0;
  }

  async call(
    contract: string,
    method: string,
    args: JsonValue[],
    execution: ExecutionContext,
  ): Promise<JsonValue | void> {
    if (execution.actorType !== "core" && !allowsPermission(execution.permissions, contract)) {
      throw new Error(`actor ${execution.actorId} is not allowed to call ${contract}`);
    }
    const registration = this.select(contract, execution);
    if (!registration) throw new Error(`no service provider available: ${contract}`);
    const target = registration.provider[method];
    if (typeof target !== "function")
      throw new Error(`service method does not exist: ${contract}.${method}`);
    return target(...args);
  }

  removeRuntime(runtimeId: string): void {
    for (const [contract, set] of this.registrations) {
      for (const registration of set) {
        if (registration.runtimeId === runtimeId) set.delete(registration);
      }
      if (set.size === 0) this.registrations.delete(contract);
    }
  }

  countRuntime(runtimeId?: string): number {
    let count = 0;
    for (const set of this.registrations.values()) {
      for (const registration of set) {
        if (!runtimeId || registration.runtimeId === runtimeId) count += 1;
      }
    }
    return count;
  }

  private select(contract: string, execution: ExecutionContext): ServiceRegistration | undefined {
    const set = this.registrations.get(contract);
    if (!set) return undefined;
    const chain = execution.scopeChain;
    let selected: ServiceRegistration | undefined;
    let selectedRank = -1;
    for (const registration of set) {
      const rank = chain.findIndex(
        (scope) => scope.type === registration.scope.type && scope.id === registration.scope.id,
      );
      if (rank < 0) continue;
      if (rank === selectedRank) {
        throw new Error(
          `ambiguous providers for ${contract} in ${registration.scope.type}:${registration.scope.id}`,
        );
      }
      if (rank > selectedRank) {
        selected = registration;
        selectedRank = rank;
      }
    }
    return selected;
  }
}

/**
 * Agent 工具属于声明组件的运行时资源。快照保留稳定处理器，但组件停止后拒绝继续执行，
 * 防止已开始的 Agent Invocation 穿透已经销毁的 Cordis Fiber。
 */
export class AgentToolRegistry {
  private readonly registrations = new Map<string, AgentToolRegistration>();
  private counter = 0;

  register(
    runtimeId: string,
    scope: ScopeAddress,
    definition: AgentToolDefinition,
    handler: AgentToolHandler,
  ): { id: string; dispose: () => void } {
    if (typeof handler !== "function") throw new TypeError("Agent 工具处理器必须是函数");
    const normalized = normalizeAgentToolDefinition(definition);
    const name = `${normalized.namespace}_${normalized.name}`;
    const existing = this.registrations.get(name);
    if (existing) {
      throw new Error(`Agent 工具 ${name} 已由 ${existing.runtimeId} 注册`);
    }

    const registration: AgentToolRegistration = {
      id: `${runtimeId}:agent-tool:${++this.counter}`,
      runtimeId,
      scope: { ...scope },
      name,
      definition: normalized,
      handler,
      active: true,
    };
    this.registrations.set(name, registration);
    return {
      id: registration.id,
      dispose: () => this.remove(registration),
    };
  }

  /** 每次 Invocation 开始时读取一次，保证单次模型闭环使用同一组工具。 */
  snapshot(): AgentToolSnapshot[] {
    return [...this.registrations.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((registration) => ({
        name: registration.name,
        definition: registration.definition,
        execute: async (input, context) => {
          if (!registration.active) {
            throw new Error(`Agent 工具已停止：${registration.name}`);
          }
          return registration.handler(input, context);
        },
      }));
  }

  removeRuntime(runtimeId: string): void {
    for (const registration of this.registrations.values()) {
      if (registration.runtimeId === runtimeId) this.remove(registration);
    }
  }

  countRuntime(runtimeId?: string): number {
    if (!runtimeId) return this.registrations.size;
    let count = 0;
    for (const registration of this.registrations.values()) {
      if (registration.runtimeId === runtimeId) count += 1;
    }
    return count;
  }

  private remove(registration: AgentToolRegistration): void {
    if (!registration.active) return;
    registration.active = false;
    if (this.registrations.get(registration.name) === registration) {
      this.registrations.delete(registration.name);
    }
  }
}

export class ContributionRegistry {
  private readonly registrations = new Map<string, ContributionRegistration>();
  private counter = 0;

  register(
    kind: string,
    runtimeId: string,
    scope: ScopeAddress,
    value: JsonValue,
  ): { id: string; dispose: () => void } {
    validateContract(kind);
    const id = `${runtimeId}:${++this.counter}`;
    this.registrations.set(id, { id, kind, runtimeId, scope, value });
    return { id, dispose: () => this.registrations.delete(id) };
  }

  list(kind?: string): ContributionSnapshot[] {
    return [...this.registrations.values()]
      .filter((registration) => !kind || registration.kind === kind)
      .map((registration) => ({ ...registration }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  removeRuntime(runtimeId: string): void {
    for (const [id, registration] of this.registrations) {
      if (registration.runtimeId === runtimeId) this.registrations.delete(id);
    }
  }
}

export class PluginEventBus {
  private readonly registrations = new Set<EventRegistration>();

  on(
    event: string,
    runtimeId: string,
    scope: ScopeAddress,
    handler: EventRegistration["handler"],
  ): () => void {
    validateContract(event);
    const registration: EventRegistration = { event, runtimeId, scope, handler };
    this.registrations.add(registration);
    return () => this.registrations.delete(registration);
  }

  async emit(event: string, payload: JsonValue, execution: ExecutionContext): Promise<void> {
    const handlers = [...this.registrations].filter(
      (registration) =>
        registration.event === event &&
        execution.scopeChain.some(
          (scope) => scope.type === registration.scope.type && scope.id === registration.scope.id,
        ),
    );
    await Promise.all(
      handlers.map((registration) => Promise.resolve(registration.handler(payload))),
    );
  }

  removeRuntime(runtimeId: string): void {
    for (const registration of this.registrations) {
      if (registration.runtimeId === runtimeId) this.registrations.delete(registration);
    }
  }
}

export function allowsPermission(permissions: readonly string[], capability: string): boolean {
  return permissions.some(
    (permission) =>
      permission === "*" ||
      permission === capability ||
      (permission.endsWith(".*") && capability.startsWith(permission.slice(0, -1))),
  );
}

function validateContract(value: string): void {
  if (!/^[a-z0-9][a-z0-9.*:-]*$/.test(value)) {
    throw new TypeError(`invalid contract identifier: ${value}`);
  }
}

function normalizeAgentToolDefinition(definition: AgentToolDefinition): AgentToolDefinition {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("Agent 工具定义必须是对象");
  }
  const namespace = validateAgentToolSegment(definition.namespace, "命名空间");
  const name = validateAgentToolSegment(definition.name, "名称");
  const title = requireAgentToolText(definition.title, "标题");
  const description = requireAgentToolText(definition.description, "描述");
  if (
    !definition.inputSchema ||
    typeof definition.inputSchema !== "object" ||
    Array.isArray(definition.inputSchema)
  ) {
    throw new TypeError(`Agent 工具 ${namespace}_${name} 的 inputSchema 必须是对象`);
  }
  if (
    definition.outputDescription !== undefined &&
    (typeof definition.outputDescription !== "string" || !definition.outputDescription.trim())
  ) {
    throw new TypeError(`Agent 工具 ${namespace}_${name} 的输出描述不能为空`);
  }
  if (definition.examples !== undefined && !Array.isArray(definition.examples)) {
    throw new TypeError(`Agent 工具 ${namespace}_${name} 的 examples 必须是数组`);
  }
  return {
    namespace,
    name,
    title,
    description,
    inputSchema: structuredClone(definition.inputSchema) as JsonObject,
    ...(definition.outputDescription === undefined
      ? {}
      : { outputDescription: definition.outputDescription.trim() }),
    ...(definition.examples === undefined
      ? {}
      : { examples: structuredClone(definition.examples) }),
  };
}

function validateAgentToolSegment(value: string, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/u.test(value)) {
    throw new TypeError(`Agent 工具${label}不合法：${String(value)}`);
  }
  return value;
}

function requireAgentToolText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Agent 工具${label}不能为空`);
  }
  return value.trim();
}
