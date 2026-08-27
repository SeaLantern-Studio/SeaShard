import type { Awaitable, ExecutionContext, JsonValue, ScopeAddress } from "@seashard/plugin-sdk";
import { validateContract } from "./shared";

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

export interface ContributionSnapshot {
  id: string;
  kind: string;
  runtimeId: string;
  scope: ScopeAddress;
  value: JsonValue;
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
