import type {
  Awaitable,
  ExecutionContext,
  JsonValue,
  RuntimePublicationSnapshot,
  ScopeAddress,
  ServiceProvider,
} from "@seashard/plugin-sdk";

interface ServiceRegistration {
  contract: string;
  runtimeId: string;
  generation: number;
  scope: ScopeAddress;
  provider: ServiceProvider;
  accepting: boolean;
  activeLeases: number;
  waiters: Set<() => void>;
}

interface ContributionRegistration {
  id: string;
  kind: string;
  runtimeId: string;
  generation: number;
  scope: ScopeAddress;
  value: JsonValue;
}

interface EventRegistration {
  event: string;
  runtimeId: string;
  generation: number;
  scope: ScopeAddress;
  handler: (payload: JsonValue) => Awaitable<void>;
}

export interface ContributionSnapshot {
  id: string;
  kind: string;
  runtimeId: string;
  generation: number;
  scope: ScopeAddress;
  value: JsonValue;
}

export class RuntimePublicationRegistry {
  private readonly slots = new Map<string, RuntimePublicationSnapshot>();

  seedEpoch(runtimeId: string, epoch: number): void {
    const current = this.slots.get(runtimeId);
    if (!current || current.epoch < epoch) {
      this.slots.set(runtimeId, { runtimeId, generation: null, epoch });
    }
  }

  publish(runtimeId: string, generation: number): RuntimePublicationSnapshot {
    const current = this.slots.get(runtimeId);
    if (current?.generation === generation) return current;
    const publication = {
      runtimeId,
      generation,
      epoch: (current?.epoch ?? 0) + 1,
    };
    this.slots.set(runtimeId, publication);
    return publication;
  }

  withdraw(runtimeId: string, generation: number): RuntimePublicationSnapshot {
    const current = this.slots.get(runtimeId);
    if (!current || current.generation === null) {
      return current ?? { runtimeId, generation: null, epoch: 0 };
    }
    if (current.generation !== generation) {
      throw new Error(
        `cannot withdraw unpublished generation ${runtimeId}@${generation}; current is ${current.generation}`,
      );
    }
    const publication = { runtimeId, generation: null, epoch: current.epoch + 1 };
    this.slots.set(runtimeId, publication);
    return publication;
  }

  isPublished(runtimeId: string, generation: number): boolean {
    return this.slots.get(runtimeId)?.generation === generation;
  }

  list(): RuntimePublicationSnapshot[] {
    return [...this.slots.values()]
      .map((publication) => ({ ...publication }))
      .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));
  }
}

export class ServiceRegistry {
  constructor(private readonly publications = new RuntimePublicationRegistry()) {}

  private readonly registrations = new Map<string, Set<ServiceRegistration>>();

  register(
    contract: string,
    runtimeId: string,
    generation: number,
    scope: ScopeAddress,
    provider: ServiceProvider,
  ): () => void {
    validateContract(contract);
    const methods = Object.entries(provider);
    if (methods.length === 0 || methods.some(([, method]) => typeof method !== "function")) {
      throw new TypeError(`service provider ${contract} must expose callable methods`);
    }
    const registration: ServiceRegistration = {
      contract,
      runtimeId,
      generation,
      scope,
      provider,
      accepting: true,
      activeLeases: 0,
      waiters: new Set(),
    };
    let set = this.registrations.get(contract);
    if (!set) {
      set = new Set();
      this.registrations.set(contract, set);
    }
    if (
      [...set].some(
        (candidate) =>
          candidate.runtimeId === runtimeId &&
          candidate.generation === generation &&
          candidate.scope.type === scope.type &&
          candidate.scope.id === scope.id,
      )
    ) {
      throw new Error(
        `service ${contract} is already registered by ${runtimeId}@${generation} in ${scope.type}:${scope.id}`,
      );
    }
    set.add(registration);
    return () => {
      registration.accepting = false;
      set?.delete(registration);
      if (set?.size === 0) this.registrations.delete(contract);
      for (const resolve of registration.waiters) resolve();
      registration.waiters.clear();
    };
  }

  has(contract: string, execution?: ExecutionContext): boolean {
    const set = this.registrations.get(contract);
    if (!set) return false;
    if (!execution) {
      return [...set].some(
        (registration) =>
          registration.accepting &&
          this.publications.isPublished(registration.runtimeId, registration.generation),
      );
    }
    return this.select(contract, execution) !== undefined;
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

    registration.activeLeases += 1;
    try {
      return await target(...args);
    } finally {
      registration.activeLeases -= 1;
      if (registration.activeLeases === 0) {
        for (const resolve of registration.waiters) resolve();
        registration.waiters.clear();
      }
    }
  }

  resumeRuntime(runtimeId: string, generation: number): void {
    for (const registration of this.forRuntime(runtimeId, generation)) {
      registration.accepting = true;
    }
  }

  async drainRuntime(runtimeId: string, generation: number): Promise<void> {
    const registrations = this.forRuntime(runtimeId, generation);
    for (const registration of registrations) registration.accepting = false;
    await Promise.all(
      registrations.map(
        (registration) =>
          new Promise<void>((resolve) => {
            if (registration.activeLeases === 0) {
              resolve();
            } else {
              registration.waiters.add(resolve);
            }
          }),
      ),
    );
  }

  assertPublishable(runtimeId: string, generation: number): void {
    for (const set of this.registrations.values()) {
      for (const candidate of set) {
        if (candidate.runtimeId !== runtimeId || candidate.generation !== generation) continue;
        const conflict = [...set].find(
          (registration) =>
            registration.runtimeId !== runtimeId &&
            this.publications.isPublished(registration.runtimeId, registration.generation) &&
            registration.scope.type === candidate.scope.type &&
            registration.scope.id === candidate.scope.id,
        );
        if (conflict) {
          throw new Error(
            `service ${candidate.contract} is already published by ${conflict.runtimeId}@${conflict.generation} in ${candidate.scope.type}:${candidate.scope.id}`,
          );
        }
      }
    }
  }

  removeRuntime(runtimeId: string, generation: number): void {
    for (const registration of this.forRuntime(runtimeId, generation)) {
      const set = this.registrations.get(registration.contract);
      set?.delete(registration);
      if (set?.size === 0) this.registrations.delete(registration.contract);
      for (const resolve of registration.waiters) resolve();
      registration.waiters.clear();
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
      if (
        !registration.accepting ||
        !this.publications.isPublished(registration.runtimeId, registration.generation)
      ) {
        continue;
      }
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

  private forRuntime(runtimeId: string, generation: number): ServiceRegistration[] {
    const result: ServiceRegistration[] = [];
    for (const set of this.registrations.values()) {
      for (const registration of set) {
        if (registration.runtimeId === runtimeId && registration.generation === generation) {
          result.push(registration);
        }
      }
    }
    return result;
  }
}

export class ContributionRegistry {
  constructor(private readonly publications = new RuntimePublicationRegistry()) {}

  private readonly registrations = new Map<string, ContributionRegistration>();
  private counter = 0;

  register(
    kind: string,
    runtimeId: string,
    generation: number,
    scope: ScopeAddress,
    value: JsonValue,
  ): { id: string; dispose: () => void } {
    validateContract(kind);
    const id = `${runtimeId}:${generation}:${++this.counter}`;
    this.registrations.set(id, { id, kind, runtimeId, generation, scope, value });
    return { id, dispose: () => this.registrations.delete(id) };
  }

  list(kind?: string): ContributionSnapshot[] {
    return [...this.registrations.values()]
      .filter(
        (registration) =>
          (!kind || registration.kind === kind) &&
          this.publications.isPublished(registration.runtimeId, registration.generation),
      )
      .map((registration) => ({ ...registration }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  removeRuntime(runtimeId: string, generation: number): void {
    for (const [id, registration] of this.registrations) {
      if (registration.runtimeId === runtimeId && registration.generation === generation) {
        this.registrations.delete(id);
      }
    }
  }
}

export class PluginEventBus {
  constructor(private readonly publications = new RuntimePublicationRegistry()) {}

  private readonly registrations = new Set<EventRegistration>();

  on(
    event: string,
    runtimeId: string,
    generation: number,
    scope: ScopeAddress,
    handler: EventRegistration["handler"],
  ): () => void {
    validateContract(event);
    const registration: EventRegistration = { event, runtimeId, generation, scope, handler };
    this.registrations.add(registration);
    return () => this.registrations.delete(registration);
  }

  async emit(event: string, payload: JsonValue, execution: ExecutionContext): Promise<void> {
    const handlers = [...this.registrations].filter(
      (registration) =>
        registration.event === event &&
        this.publications.isPublished(registration.runtimeId, registration.generation) &&
        execution.scopeChain.some(
          (scope) => scope.type === registration.scope.type && scope.id === registration.scope.id,
        ),
    );
    await Promise.all(
      handlers.map((registration) => Promise.resolve(registration.handler(payload))),
    );
  }

  removeRuntime(runtimeId: string, generation: number): void {
    for (const registration of this.registrations) {
      if (registration.runtimeId === runtimeId && registration.generation === generation) {
        this.registrations.delete(registration);
      }
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
