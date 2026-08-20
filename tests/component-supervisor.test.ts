import assert from "node:assert/strict";
import test from "node:test";
import {
  ComponentSupervisor,
  type RuntimeBackend,
  type RuntimeStateStore,
  type SupervisedEntry,
} from "../packages/component-supervisor/src/index.ts";
import type {
  JsonValue,
  PluginManifest,
  RuntimeGenerationSnapshot,
  RuntimeOperationSnapshot,
  RuntimePublicationSnapshot,
  UpgradeMode,
} from "../packages/plugin-sdk/src/index.ts";
import { RuntimePublicationRegistry } from "../packages/plugin-system/src/runtime-registries.ts";
import { validManifest } from "./plugin-test-fixtures.ts";

class MemoryRuntimeStore implements RuntimeStateStore {
  private readonly generations = new Map<string, number>();

  async nextGeneration(runtimeId: string): Promise<number> {
    const generation = (this.generations.get(runtimeId) ?? 0) + 1;
    this.generations.set(runtimeId, generation);
    return generation;
  }

  async saveRuntimeGeneration(_snapshot: RuntimeGenerationSnapshot): Promise<void> {}
  async saveRuntimePublication(_snapshot: RuntimePublicationSnapshot): Promise<void> {}
  async saveRuntimeOperation(_snapshot: RuntimeOperationSnapshot): Promise<void> {}

  async appendJournal(
    _category: string,
    _aggregateId: string,
    _payload: JsonValue,
  ): Promise<number> {
    return 1;
  }
}

class RecordingBackend implements RuntimeBackend {
  private readonly publications = new RuntimePublicationRegistry();
  onDrain?: (generation: number) => void | Promise<void>;

  constructor(
    private readonly events: string[],
    private readonly failedStarts = new Set<number>(),
  ) {}

  async prepare(_entry: SupervisedEntry, generation: number) {
    this.events.push(`prepare:${generation}`);
    return {
      dependencies: [],
      provides: ["example.echo"],
      start: async () => {
        this.events.push(`start:${generation}`);
        if (this.failedStarts.has(generation)) throw new Error(`generation ${generation} failed`);
        return {
          drain: async () => {
            this.events.push(`drain:${generation}`);
            await this.onDrain?.(generation);
          },
          stop: async () => {
            this.events.push(`stop:${generation}`);
          },
        };
      },
      discard: async () => {},
    };
  }

  dependencyAvailable(): boolean {
    return true;
  }

  publish(runtimeId: string, generation: number): RuntimePublicationSnapshot {
    this.events.push(`publish:${generation}`);
    return this.publications.publish(runtimeId, generation);
  }

  withdraw(runtimeId: string, generation: number): RuntimePublicationSnapshot {
    this.events.push(`withdraw:${generation}`);
    return this.publications.withdraw(runtimeId, generation);
  }
}

function entryFor(version: string, upgradeMode: UpgradeMode): SupervisedEntry {
  const manifest: PluginManifest = {
    ...validManifest,
    version,
    entries: [{ ...validManifest.entries[0], upgradeMode }],
  };
  return {
    package: {
      manifest,
      digest: version.padEnd(64, "0"),
      rootPath: `builtin:${version}`,
      source: "builtin",
      trust: "builtin",
    },
    entry: manifest.entries[0],
    binding: {
      id: "example.runtime",
      pluginId: manifest.id,
      entryId: manifest.entries[0].id,
      scopeType: "global",
      scopeId: "global",
      enabled: true,
      config: null,
    },
    runtimeId: "example.runtime",
    host: "core",
  };
}

await test("supervisor reports dependency cycles without publishing candidates", async () => {
  const publications = new RuntimePublicationRegistry();
  const backend: RuntimeBackend = {
    async prepare(entry) {
      const first = entry.entry.id === "first.host";
      return {
        dependencies: [first ? "service.second" : "service.first"],
        provides: [first ? "service.first" : "service.second"],
        start: async () => {
          throw new Error("cyclic runtime must not start");
        },
        discard: async () => {},
      };
    },
    dependencyAvailable() {
      return false;
    },
    publish(runtimeId, generation) {
      return publications.publish(runtimeId, generation);
    },
    withdraw(runtimeId, generation) {
      return publications.withdraw(runtimeId, generation);
    },
  };
  const supervisor = new ComponentSupervisor(backend, new MemoryRuntimeStore());
  const manifest: PluginManifest = {
    ...validManifest,
    entries: [
      { ...validManifest.entries[0], id: "first.host" },
      { ...validManifest.entries[0], id: "second.host" },
    ],
  };
  const packageRecord = {
    manifest,
    digest: "a".repeat(64),
    rootPath: "builtin:cycle",
    source: "builtin" as const,
    trust: "builtin" as const,
  };
  await supervisor.reconcile(
    manifest.entries.map((entry) => ({
      package: packageRecord,
      entry,
      binding: {
        id: `cycle.${entry.id}`,
        pluginId: manifest.id,
        entryId: entry.id,
        scopeType: "global" as const,
        scopeId: "global",
        enabled: true,
        config: null,
      },
      runtimeId: `cycle.${entry.id}`,
      host: "core" as const,
    })),
  );

  const snapshot = supervisor.snapshot();
  assert.equal(
    snapshot.publications.every((publication) => publication.generation === null),
    true,
  );
  assert.equal(snapshot.generations.length, 2);
  assert.equal(
    snapshot.generations.every((generation) => generation.phase === "failed"),
    true,
  );
  assert.match(snapshot.generations[0]?.error ?? "", /dependency cycle/);
  assert.equal(
    snapshot.operations.every((operation) => operation.status === "failed"),
    true,
  );
  await supervisor.dispose();
});

await test("hot-swap publishes the candidate before draining the previous generation", async () => {
  const events: string[] = [];
  const backend = new RecordingBackend(events);
  const supervisor = new ComponentSupervisor(backend, new MemoryRuntimeStore());

  await supervisor.reconcile([entryFor("1.0.0", "hot-swap")]);
  await supervisor.reconcile([entryFor("2.0.0", "hot-swap")]);

  assert.deepEqual(events, [
    "prepare:1",
    "start:1",
    "publish:1",
    "prepare:2",
    "start:2",
    "publish:2",
    "drain:1",
    "stop:1",
  ]);
  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.publications[0]?.generation, 2);
  assert.equal(
    snapshot.generations.find((generation) => generation.generation === 1)?.phase,
    "terminated",
  );
  assert.equal(
    snapshot.generations.find((generation) => generation.generation === 2)?.phase,
    "running",
  );
  await supervisor.dispose();
});

await test("hot-swap restores previous publication when candidate dies during drain", async () => {
  const events: string[] = [];
  const backend = new RecordingBackend(events);
  const supervisor = new ComponentSupervisor(backend, new MemoryRuntimeStore());
  backend.onDrain = async (generation) => {
    if (generation === 1) {
      await supervisor.runtimeFailed("example.runtime", 2, new Error("candidate host crashed"));
    }
  };

  await supervisor.reconcile([entryFor("1.0.0", "hot-swap")]);
  await supervisor.reconcile([entryFor("2.0.0", "hot-swap")]);

  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.publications[0]?.generation, 1);
  assert.equal(
    snapshot.generations.find((generation) => generation.generation === 1)?.phase,
    "running",
  );
  assert.equal(
    snapshot.generations.find((generation) => generation.generation === 2)?.phase,
    "failed",
  );
  assert.equal(snapshot.operations[0]?.attentionRequired, false);
  assert.deepEqual(events, [
    "prepare:1",
    "start:1",
    "publish:1",
    "prepare:2",
    "start:2",
    "publish:2",
    "drain:1",
    "withdraw:2",
    "publish:1",
  ]);
  await supervisor.dispose();
});

await test("failed hot-swap candidate leaves the previous generation published", async () => {
  const events: string[] = [];
  const backend = new RecordingBackend(events, new Set([2]));
  const supervisor = new ComponentSupervisor(backend, new MemoryRuntimeStore());

  await supervisor.reconcile([entryFor("1.0.0", "hot-swap")]);
  await supervisor.reconcile([entryFor("2.0.0", "hot-swap")]);

  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.publications[0]?.generation, 1);
  assert.equal(snapshot.operations[0]?.status, "failed");
  assert.equal(snapshot.operations[0]?.attentionRequired, false);
  assert.deepEqual(events, ["prepare:1", "start:1", "publish:1", "prepare:2", "start:2"]);
  await supervisor.dispose();
});

await test("stop-first drains and stops the previous generation before starting candidate", async () => {
  const events: string[] = [];
  const backend = new RecordingBackend(events);
  const supervisor = new ComponentSupervisor(backend, new MemoryRuntimeStore());

  await supervisor.reconcile([entryFor("1.0.0", "stop-first")]);
  await supervisor.reconcile([entryFor("2.0.0", "stop-first")]);

  assert.deepEqual(events, [
    "prepare:1",
    "start:1",
    "publish:1",
    "prepare:2",
    "withdraw:1",
    "drain:1",
    "stop:1",
    "start:2",
    "publish:2",
  ]);
  assert.equal(supervisor.snapshot().publications[0]?.generation, 2);
  await supervisor.dispose();
});
await test("failed stop-first candidate restores the previous specification", async () => {
  const events: string[] = [];
  const backend = new RecordingBackend(events, new Set([2]));
  const supervisor = new ComponentSupervisor(backend, new MemoryRuntimeStore());

  await supervisor.reconcile([entryFor("1.0.0", "stop-first")]);
  await supervisor.reconcile([entryFor("2.0.0", "stop-first")]);

  const snapshot = supervisor.snapshot();
  const published = snapshot.generations.find(
    (generation) =>
      generation.runtimeId === "example.runtime" &&
      generation.generation === snapshot.publications[0]?.generation,
  );
  assert.equal(published?.generation, 3);
  assert.equal(published?.pluginVersion, "1.0.0");
  assert.equal(snapshot.operations[0]?.status, "failed");
  assert.equal(snapshot.operations[0]?.attentionRequired, false);
  assert.deepEqual(events, [
    "prepare:1",
    "start:1",
    "publish:1",
    "prepare:2",
    "withdraw:1",
    "drain:1",
    "stop:1",
    "start:2",
    "prepare:3",
    "start:3",
    "publish:3",
  ]);
  await supervisor.dispose();
});
