import type {
  ExecutionContext,
  JsonValue,
  PluginBinding,
  PluginEntryManifest,
  PluginManifest,
  PluginSourceKind,
  PluginTrustLevel,
  RuntimeControlSnapshot,
  RuntimeGenerationSnapshot,
  RuntimeOperationKind,
  RuntimeOperationSnapshot,
  RuntimeOperationStep,
  RuntimePublicationSnapshot,
} from "@seashard/plugin-sdk";
import { randomUUID } from "node:crypto";

export interface SupervisedEntry {
  package: {
    manifest: PluginManifest;
    digest: string;
    rootPath: string;
    source: PluginSourceKind;
    trust: PluginTrustLevel;
  };
  entry: PluginEntryManifest;
  binding: PluginBinding;
  runtimeId: string;
  host: "core" | "node-plugin-host" | "client";
}

export interface PreparedRuntime {
  readonly dependencies: readonly string[];
  readonly provides: readonly string[];
  start(): Promise<RuntimeHandle>;
  discard(): Promise<void>;
}

export interface RuntimeHandle {
  drain(): Promise<void>;
  stop(): Promise<void>;
}

export interface RuntimeBackend {
  prepare(entry: SupervisedEntry, generation: number): Promise<PreparedRuntime>;
  dependencyAvailable(contract: string, execution: ExecutionContext): boolean;
  publish(runtimeId: string, generation: number): RuntimePublicationSnapshot;
  withdraw(runtimeId: string, generation: number): RuntimePublicationSnapshot;
}

export interface RuntimeStateStore {
  nextGeneration(runtimeId: string): number;
  saveRuntimeGeneration(snapshot: RuntimeGenerationSnapshot): void;
  saveRuntimePublication(snapshot: RuntimePublicationSnapshot): void;
  saveRuntimeOperation(snapshot: RuntimeOperationSnapshot): void;
  appendJournal(category: string, aggregateId: string, payload: JsonValue): number;
}

interface RuntimeGeneration {
  entry: SupervisedEntry;
  identity: string;
  generation: number;
  phase: RuntimeGenerationSnapshot["phase"];
  dependencies: readonly string[];
  provides: readonly string[];
  prepared?: PreparedRuntime;
  handle?: RuntimeHandle;
  error?: string;
}

interface RuntimeSlot {
  desiredEntry: SupervisedEntry;
  desiredIdentity: string;
  generations: Map<number, RuntimeGeneration>;
  published?: RuntimeGeneration;
  candidate?: RuntimeGeneration;
  publication?: RuntimePublicationSnapshot;
  operation?: RuntimeOperationSnapshot;
}

export class ComponentSupervisor {
  private readonly slots = new Map<string, RuntimeSlot>();
  private stopping = false;
  private disposeTask?: Promise<void>;

  constructor(
    private readonly backend: RuntimeBackend,
    private readonly store: RuntimeStateStore,
  ) {}

  async reconcile(entries: readonly SupervisedEntry[]): Promise<void> {
    if (this.stopping) throw new Error("component supervisor is stopping");
    const incoming = new Map(entries.map((entry) => [entry.runtimeId, entry]));

    for (const [runtimeId, slot] of this.slots) {
      const next = incoming.get(runtimeId);
      if (!next || !next.binding.enabled) {
        await this.deactivateSlot(slot);
        this.slots.delete(runtimeId);
      }
    }

    for (const entry of entries) {
      if (!entry.binding.enabled) continue;
      const identity = entryIdentity(entry);
      let slot = this.slots.get(entry.runtimeId);
      if (!slot) {
        slot = {
          desiredEntry: entry,
          desiredIdentity: identity,
          generations: new Map(),
        };
        this.slots.set(entry.runtimeId, slot);
      } else {
        slot.desiredEntry = entry;
        slot.desiredIdentity = identity;
      }

      if (slot.candidate && slot.candidate.identity !== identity) {
        await this.abandonCandidate(slot, "candidate superseded by a new desired specification");
      }
      if (slot.published?.identity === identity && slot.published.phase === "running") continue;
      if (slot.candidate?.identity === identity && slot.candidate.phase === "prepared") continue;
      await this.prepareCandidate(slot, entry, identity, slot.published ? "replace" : "activate");
    }

    await this.failDependencyCycles();
    await this.activateReadyCandidates();
  }

  async reload(runtimeId: string): Promise<void> {
    if (this.stopping) throw new Error("component supervisor is stopping");
    const slot = this.slots.get(runtimeId);
    if (!slot) throw new Error(`runtime binding does not exist: ${runtimeId}`);
    await this.abandonCandidate(slot, "candidate superseded by explicit reload");
    await this.prepareCandidate(slot, slot.desiredEntry, slot.desiredIdentity, "reload");
    await this.failDependencyCycles();
    await this.activateReadyCandidates();
    if (slot.operation?.status !== "completed") {
      throw new Error(slot.operation?.error ?? `runtime reload did not complete: ${runtimeId}`);
    }
  }

  runtimeFailed(runtimeId: string, generation: number, error: Error): void {
    const slot = this.slots.get(runtimeId);
    const failed = slot?.generations.get(generation);
    if (!slot || !failed || failed.phase === "failed" || failed.phase === "terminated") return;

    failed.phase = "failed";
    failed.error = error.message;
    failed.handle = undefined;
    failed.prepared = undefined;
    this.persistGeneration(failed);

    if (slot.published?.generation === generation) {
      const publication = this.backend.withdraw(runtimeId, generation);
      slot.publication = publication;
      slot.published = undefined;
      this.persistPublication(publication);
    }
    if (slot.candidate?.generation === generation) slot.candidate = undefined;
    if (slot.operation?.status === "running") {
      this.failOperation(slot.operation, error.message, slot.published === undefined);
    }
  }

  snapshot(): RuntimeControlSnapshot {
    const generations = [...this.slots.values()]
      .flatMap((slot) =>
        [...slot.generations.values()].map((generation) => this.toSnapshot(generation)),
      )
      .sort(
        (left, right) =>
          left.runtimeId.localeCompare(right.runtimeId) || left.generation - right.generation,
      );
    const publications = [...this.slots.values()]
      .map(
        (slot) =>
          slot.publication ?? {
            runtimeId: slot.desiredEntry.runtimeId,
            generation: null,
            epoch: 0,
          },
      )
      .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));
    const operations = [...this.slots.values()]
      .flatMap((slot) => (slot.operation ? [slot.operation] : []))
      .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));
    return { generations, publications, operations };
  }

  dispose(): Promise<void> {
    this.disposeTask ??= this.disposeSlots();
    return this.disposeTask;
  }

  private async prepareCandidate(
    slot: RuntimeSlot,
    entry: SupervisedEntry,
    identity: string,
    kind: RuntimeOperationKind,
  ): Promise<void> {
    const generationNumber = this.store.nextGeneration(entry.runtimeId);
    const operation: RuntimeOperationSnapshot = {
      id: `${entry.runtimeId}:${generationNumber}:${randomUUID()}`,
      runtimeId: entry.runtimeId,
      kind,
      mode: entry.entry.upgradeMode,
      status: "running",
      step: "prepare",
      currentGeneration: slot.published?.generation ?? null,
      candidateGeneration: generationNumber,
      attentionRequired: false,
    };
    slot.operation = operation;
    this.persistOperation(operation);

    try {
      const prepared = await this.backend.prepare(entry, generationNumber);
      const generation: RuntimeGeneration = {
        entry,
        identity,
        generation: generationNumber,
        phase: "prepared",
        dependencies: uniqueSorted(prepared.dependencies),
        provides: uniqueSorted(prepared.provides),
        prepared,
      };
      slot.generations.set(generationNumber, generation);
      slot.candidate = generation;
      this.persistGeneration(generation);
    } catch (error) {
      const message = formatError(error);
      const generation: RuntimeGeneration = {
        entry,
        identity,
        generation: generationNumber,
        phase: "failed",
        dependencies: [],
        provides: [],
        error: message,
      };
      slot.generations.set(generationNumber, generation);
      this.persistGeneration(generation);
      this.failOperation(operation, message, slot.published === undefined);
    }
  }

  private async activateReadyCandidates(): Promise<void> {
    let progress = true;
    while (progress) {
      progress = false;
      for (const slot of this.slots.values()) {
        const candidate = slot.candidate;
        if (!candidate || candidate.phase !== "prepared") continue;
        const execution = executionFor(candidate.entry, candidate.generation);
        const missing = candidate.dependencies.filter(
          (contract) => !this.backend.dependencyAvailable(contract, execution),
        );
        if (missing.length) {
          candidate.error = `waiting for services: ${missing.join(", ")}`;
          this.setOperationStep(slot.operation, "wait-dependencies");
          this.persistGeneration(candidate);
          continue;
        }
        candidate.error = undefined;
        if (await this.deployCandidate(slot, candidate)) progress = true;
      }
    }
  }

  private async deployCandidate(slot: RuntimeSlot, candidate: RuntimeGeneration): Promise<boolean> {
    const previous = slot.published;
    const operation = requiredOperation(slot);

    if (previous && candidate.entry.entry.upgradeMode === "stop-first") {
      this.withdraw(slot, previous);
      try {
        await this.stopPrevious(operation, previous);
      } catch (error) {
        const message = `previous generation could not stop: ${formatError(error)}`;
        try {
          await candidate.prepared?.discard();
        } finally {
          candidate.prepared = undefined;
          candidate.phase = "terminated";
          candidate.error = message;
          slot.candidate = undefined;
          this.persistGeneration(candidate);
          this.failOperation(operation, message, true);
        }
        return false;
      }
    }

    try {
      await this.startCandidate(operation, candidate);
      this.setOperationStep(operation, "publish");
      const publication = this.backend.publish(candidate.entry.runtimeId, candidate.generation);
      slot.publication = publication;
      slot.published = candidate;
      slot.candidate = undefined;
      this.persistPublication(publication);
    } catch (error) {
      const message = formatError(error);
      await this.rejectCandidate(candidate, message);
      slot.candidate = undefined;
      if (previous && candidate.entry.entry.upgradeMode === "stop-first") {
        await this.rollback(slot, previous, operation, message);
      } else {
        this.failOperation(operation, message, slot.published === undefined);
      }
      return false;
    }

    if (previous && previous.phase === "running") {
      try {
        const stopped = await this.stopPrevious(
          operation,
          previous,
          () =>
            candidate.phase === "running" && slot.published?.generation === candidate.generation,
        );
        if (!stopped) {
          const publication = this.backend.publish(previous.entry.runtimeId, previous.generation);
          slot.publication = publication;
          slot.published = previous;
          this.persistPublication(publication);
          this.failOperation(
            operation,
            candidate.error ?? "candidate failed before previous generation stopped",
            false,
          );
          return false;
        }
      } catch (error) {
        this.failOperation(
          operation,
          `new generation is published but previous cleanup failed: ${formatError(error)}`,
          true,
        );
        return true;
      }
    }

    operation.status = "completed";
    operation.attentionRequired = false;
    operation.error = undefined;
    this.persistOperation(operation);
    return true;
  }

  private async startCandidate(
    operation: RuntimeOperationSnapshot,
    candidate: RuntimeGeneration,
  ): Promise<void> {
    if (!candidate.prepared) {
      throw new Error(
        `runtime generation is not prepared: ${candidate.entry.runtimeId}@${candidate.generation}`,
      );
    }
    this.setOperationStep(operation, "start-candidate");
    candidate.handle = await candidate.prepared.start();
    candidate.prepared = undefined;
    if (candidate.phase === "failed") {
      throw new Error(candidate.error ?? "runtime generation failed during startup");
    }
    candidate.phase = "running";
    this.persistGeneration(candidate);
  }

  private async stopPrevious(
    operation: RuntimeOperationSnapshot,
    previous: RuntimeGeneration,
    mayStop?: () => boolean,
  ): Promise<boolean> {
    if (!previous.handle) return true;
    this.setOperationStep(operation, "drain-previous");
    await previous.handle.drain();
    if (mayStop && !mayStop()) return false;
    this.setOperationStep(operation, "stop-previous");
    try {
      await previous.handle.stop();
      previous.phase = "terminated";
      previous.error = undefined;
      return true;
    } catch (error) {
      previous.phase = "failed";
      previous.error = formatError(error);
      throw error;
    } finally {
      previous.handle = undefined;
      this.persistGeneration(previous);
    }
  }

  private async rejectCandidate(candidate: RuntimeGeneration, message: string): Promise<void> {
    let error = message;
    try {
      if (candidate.handle) {
        await candidate.handle.drain();
        await candidate.handle.stop();
      } else {
        await candidate.prepared?.discard();
      }
    } catch (cleanupError) {
      error = `${message}; candidate cleanup failed: ${formatError(cleanupError)}`;
    } finally {
      candidate.handle = undefined;
      candidate.prepared = undefined;
      candidate.phase = "failed";
      candidate.error = error;
      this.persistGeneration(candidate);
    }
  }

  private async rollback(
    slot: RuntimeSlot,
    previous: RuntimeGeneration,
    operation: RuntimeOperationSnapshot,
    candidateError: string,
  ): Promise<void> {
    this.setOperationStep(operation, "rollback");
    const generationNumber = this.store.nextGeneration(previous.entry.runtimeId);
    let restored: RuntimeGeneration | undefined;
    try {
      const prepared = await this.backend.prepare(previous.entry, generationNumber);
      restored = {
        entry: previous.entry,
        identity: previous.identity,
        generation: generationNumber,
        phase: "prepared",
        dependencies: uniqueSorted(prepared.dependencies),
        provides: uniqueSorted(prepared.provides),
        prepared,
      };
      slot.generations.set(generationNumber, restored);
      this.persistGeneration(restored);
      await this.startCandidate(operation, restored);
      const publication = this.backend.publish(restored.entry.runtimeId, restored.generation);
      slot.publication = publication;
      slot.published = restored;
      this.persistPublication(publication);
      this.failOperation(
        operation,
        `candidate failed and previous specification was restored: ${candidateError}`,
        false,
      );
    } catch (error) {
      const rollbackError = formatError(error);
      if (restored) {
        await this.rejectCandidate(restored, rollbackError);
      } else {
        restored = {
          entry: previous.entry,
          identity: previous.identity,
          generation: generationNumber,
          phase: "failed",
          dependencies: [],
          provides: [],
          error: rollbackError,
        };
        slot.generations.set(generationNumber, restored);
        this.persistGeneration(restored);
      }
      this.failOperation(
        operation,
        `candidate failed: ${candidateError}; rollback failed: ${rollbackError}`,
        true,
      );
    }
  }

  private withdraw(slot: RuntimeSlot, generation: RuntimeGeneration): void {
    const publication = this.backend.withdraw(generation.entry.runtimeId, generation.generation);
    slot.publication = publication;
    if (slot.published?.generation === generation.generation) slot.published = undefined;
    this.persistPublication(publication);
  }

  private async abandonCandidate(slot: RuntimeSlot, reason: string): Promise<void> {
    const candidate = slot.candidate;
    if (!candidate) return;
    if (candidate.handle) {
      await candidate.handle.drain();
      await candidate.handle.stop();
    } else {
      await candidate.prepared?.discard();
    }
    candidate.handle = undefined;
    candidate.prepared = undefined;
    candidate.phase = "terminated";
    candidate.error = reason;
    slot.candidate = undefined;
    this.persistGeneration(candidate);
    if (slot.operation?.status === "running") {
      slot.operation.status = "interrupted";
      slot.operation.error = reason;
      this.persistOperation(slot.operation);
    }
  }

  private async deactivateSlot(slot: RuntimeSlot): Promise<void> {
    await this.abandonCandidate(slot, "binding was disabled or removed");
    const current = slot.published;
    if (!current) return;
    const operation = this.createDeactivateOperation(slot, current);
    this.withdraw(slot, current);
    try {
      await this.stopPrevious(operation, current);
      operation.status = "completed";
      this.persistOperation(operation);
    } catch (error) {
      this.failOperation(operation, formatError(error), true);
    }
  }

  private createDeactivateOperation(
    slot: RuntimeSlot,
    current: RuntimeGeneration,
  ): RuntimeOperationSnapshot {
    const operation: RuntimeOperationSnapshot = {
      id: `${current.entry.runtimeId}:deactivate:${randomUUID()}`,
      runtimeId: current.entry.runtimeId,
      kind: "deactivate",
      mode: current.entry.entry.upgradeMode,
      status: "running",
      step: "drain-previous",
      currentGeneration: current.generation,
      candidateGeneration: null,
      attentionRequired: false,
    };
    slot.operation = operation;
    this.persistOperation(operation);
    return operation;
  }

  private async failDependencyCycles(): Promise<void> {
    while (true) {
      const candidates = [...this.slots.values()]
        .map((slot) => slot.candidate)
        .filter((candidate): candidate is RuntimeGeneration => candidate?.phase === "prepared");
      const providers = new Map<string, RuntimeGeneration[]>();
      for (const candidate of candidates) {
        for (const contract of candidate.provides) {
          const list = providers.get(contract) ?? [];
          list.push(candidate);
          providers.set(contract, list);
        }
      }

      const edges = new Map<string, string[]>();
      for (const candidate of candidates) {
        const execution = executionFor(candidate.entry, candidate.generation);
        const dependencies = candidate.dependencies.flatMap((contract) => {
          if (this.backend.dependencyAvailable(contract, execution)) return [];
          return (providers.get(contract) ?? []).map((provider) => provider.entry.runtimeId);
        });
        edges.set(candidate.entry.runtimeId, dependencies);
      }

      const cycle = findCycle(edges);
      if (!cycle) return;
      const message = `component dependency cycle: ${cycle.join(" -> ")}`;
      for (const runtimeId of new Set(cycle)) {
        const slot = this.slots.get(runtimeId);
        const candidate = slot?.candidate;
        if (!slot || !candidate) continue;
        await candidate.prepared?.discard();
        candidate.prepared = undefined;
        candidate.phase = "failed";
        candidate.error = message;
        slot.candidate = undefined;
        this.persistGeneration(candidate);
        this.failOperation(requiredOperation(slot), message, slot.published === undefined);
      }
    }
  }

  private setOperationStep(
    operation: RuntimeOperationSnapshot | undefined,
    step: RuntimeOperationStep,
  ): void {
    if (!operation || operation.status !== "running" || operation.step === step) return;
    operation.step = step;
    this.persistOperation(operation);
  }

  private failOperation(
    operation: RuntimeOperationSnapshot,
    error: string,
    attentionRequired: boolean,
  ): void {
    operation.status = "failed";
    operation.error = error;
    operation.attentionRequired = attentionRequired;
    this.persistOperation(operation);
  }

  private persistGeneration(generation: RuntimeGeneration): void {
    const snapshot = this.toSnapshot(generation);
    this.store.saveRuntimeGeneration(snapshot);
    this.store.appendJournal(
      "plugin.runtime.generation",
      `${snapshot.runtimeId}@${snapshot.generation}`,
      snapshot as unknown as JsonValue,
    );
  }

  private persistPublication(publication: RuntimePublicationSnapshot): void {
    this.store.saveRuntimePublication(publication);
    this.store.appendJournal(
      "plugin.runtime.publication",
      publication.runtimeId,
      publication as unknown as JsonValue,
    );
  }

  private persistOperation(operation: RuntimeOperationSnapshot): void {
    this.store.saveRuntimeOperation(operation);
    this.store.appendJournal(
      "plugin.runtime.operation",
      operation.id,
      operation as unknown as JsonValue,
    );
  }

  private toSnapshot(generation: RuntimeGeneration): RuntimeGenerationSnapshot {
    return {
      runtimeId: generation.entry.runtimeId,
      pluginId: generation.entry.package.manifest.id,
      pluginVersion: generation.entry.package.manifest.version,
      entryId: generation.entry.entry.id,
      bindingId: generation.entry.binding.id,
      source: generation.entry.package.source,
      trust: generation.entry.package.trust,
      scopeType: generation.entry.binding.scopeType,
      scopeId: generation.entry.binding.scopeId,
      generation: generation.generation,
      phase: generation.phase,
      upgradeMode: generation.entry.entry.upgradeMode,
      host: generation.entry.host,
      dependencies: generation.dependencies,
      ...(generation.error ? { error: generation.error } : {}),
    };
  }

  private async disposeSlots(): Promise<void> {
    this.stopping = true;
    for (const slot of [...this.slots.values()].reverse()) {
      await this.deactivateSlot(slot);
    }
  }
}

function requiredOperation(slot: RuntimeSlot): RuntimeOperationSnapshot {
  if (!slot.operation)
    throw new Error(`runtime operation is missing: ${slot.desiredEntry.runtimeId}`);
  return slot.operation;
}

function entryIdentity(entry: SupervisedEntry): string {
  return JSON.stringify({
    digest: entry.package.digest,
    entry: entry.entry.id,
    binding: entry.binding,
    host: entry.host,
  });
}

function executionFor(entry: SupervisedEntry, generation: number): ExecutionContext {
  const ownScope = { type: entry.binding.scopeType, id: entry.binding.scopeId } as const;
  return {
    actorType: "plugin",
    actorId: entry.package.manifest.id,
    runtimeId: entry.runtimeId,
    generation,
    scopeType: ownScope.type,
    scopeId: ownScope.id,
    scopeChain:
      ownScope.type === "global" ? [ownScope] : [{ type: "global", id: "global" }, ownScope],
    permissions: entry.entry.permissions,
    permissionRevision: 1,
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function findCycle(edges: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (node: string): string[] | undefined => {
    if (visiting.has(node)) {
      const index = path.indexOf(node);
      return [...path.slice(index), node];
    }
    if (visited.has(node)) return undefined;
    visiting.add(node);
    path.push(node);
    for (const dependency of edges.get(node) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(node);
    visited.add(node);
    return undefined;
  };

  for (const node of edges.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
