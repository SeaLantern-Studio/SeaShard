import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ComponentSupervisor,
  type RuntimeBackend,
  type RuntimeStateStore,
  type SupervisedEntry,
} from "../packages/component-supervisor/src/index.ts";
import type {
  ExecutionContext,
  JsonValue,
  PluginManifest,
  RuntimeGenerationSnapshot,
  RuntimeOperationSnapshot,
  RuntimePublicationSnapshot,
  UpgradeMode,
} from "../packages/plugin-sdk/src/index.ts";
import { parsePluginManifest } from "../packages/plugin-system/src/manifest.ts";
import { PluginStore } from "../packages/plugin-system/src/store.ts";
import {
  RuntimePublicationRegistry,
  ServiceRegistry,
} from "../packages/plugin-system/src/runtime-registries.ts";

const validManifest: PluginManifest = {
  id: "example.plugin",
  version: "1.0.0",
  publisher: "example-publisher",
  entries: [
    {
      id: "example.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron"],
      activationScopes: ["global"],
      permissions: ["example.echo"],
      upgradeMode: "hot-swap",
    },
  ],
  compatibility: { seaShard: ">=0.0.0 <1.0.0" },
};

class MemoryRuntimeStore implements RuntimeStateStore {
  private readonly generations = new Map<string, number>();

  nextGeneration(runtimeId: string): number {
    const generation = (this.generations.get(runtimeId) ?? 0) + 1;
    this.generations.set(runtimeId, generation);
    return generation;
  }

  saveRuntimeGeneration(_snapshot: RuntimeGenerationSnapshot): void {}
  saveRuntimePublication(_snapshot: RuntimePublicationSnapshot): void {}
  saveRuntimeOperation(_snapshot: RuntimeOperationSnapshot): void {}

  appendJournal(_category: string, _aggregateId: string, _payload: JsonValue): number {
    return 1;
  }
}

class RecordingBackend implements RuntimeBackend {
  private readonly publications = new RuntimePublicationRegistry();
  onDrain?: (generation: number) => void;

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
            this.onDrain?.(generation);
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
await test("manifest parser rejects unknown fields and module traversal", () => {
  assert.deepEqual(parsePluginManifest(validManifest, "0.0.0"), validManifest);
  assert.throws(
    () => parsePluginManifest({ ...validManifest, typo: true }, "0.0.0"),
    /manifest\.typo is not supported/,
  );
  assert.throws(
    () =>
      parsePluginManifest(
        {
          ...validManifest,
          entries: [{ ...validManifest.entries[0], module: "../outside.js" }],
        },
        "0.0.0",
      ),
    /without traversal/,
  );
});
await test("schema v1 migrates runtime counters and manifest upgrade mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-store-"));
  const databasePath = join(directory, "seashard.sqlite3");
  const database = new DatabaseSync(databasePath);
  const legacyManifest = JSON.parse(JSON.stringify(validManifest)) as {
    entries: Array<Record<string, unknown>>;
  };
  legacyManifest.entries[0].reloadPolicy = "quiesce";
  delete legacyManifest.entries[0].upgradeMode;
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations (version, applied_at) VALUES (1, 'legacy');

    CREATE TABLE plugin_packages (
      plugin_id TEXT NOT NULL,
      version TEXT NOT NULL,
      digest TEXT NOT NULL,
      publisher TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      trust_level TEXT NOT NULL,
      root_path TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, version, digest)
    ) STRICT;

    CREATE TABLE plugin_runtime_units (
      runtime_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL
    ) STRICT;
    INSERT INTO plugin_runtime_units (runtime_id, generation)
    VALUES ('example.runtime', 7);
  `);
  database
    .prepare(
      `INSERT INTO plugin_packages (
         plugin_id, version, digest, publisher, source_kind, trust_level,
         root_path, manifest_json, installed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      validManifest.id,
      validManifest.version,
      "a".repeat(64),
      validManifest.publisher,
      "installed",
      "package-full-trust",
      directory,
      JSON.stringify(legacyManifest),
      "legacy",
    );
  database.close();

  let store: PluginStore | undefined;
  try {
    store = new PluginStore(databasePath, "0.0.0");
    assert.equal(store.listPackages()[0]?.manifest.entries[0]?.upgradeMode, "stop-first");
    assert.equal(store.nextGeneration("example.runtime"), 8);
    assert.deepEqual(store.listRuntimeGenerations(), []);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("service publication switches generations before draining old leases", async () => {
  const publications = new RuntimePublicationRegistry();
  const registry = new ServiceRegistry(publications);
  registry.register(
    "example.echo",
    "global-provider",
    1,
    { type: "global", id: "global" },
    {
      echo: () => "global",
    },
  );
  publications.publish("global-provider", 1);

  let release: (() => void) | undefined;
  registry.register(
    "example.echo",
    "server-provider",
    1,
    { type: "server", id: "server-a" },
    {
      echo: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return "server-one";
      },
    },
  );
  registry.register(
    "example.echo",
    "server-provider",
    2,
    { type: "server", id: "server-a" },
    {
      echo: () => "server-two",
    },
  );
  publications.publish("server-provider", 1);

  const execution: ExecutionContext = {
    actorType: "plugin",
    actorId: "caller",
    runtimeId: "caller",
    generation: 1,
    scopeType: "server",
    scopeId: "server-a",
    scopeChain: [
      { type: "global", id: "global" },
      { type: "server", id: "server-a" },
    ],
    permissions: ["example.echo"],
    permissionRevision: 1,
  };

  const oldCall = registry.call("example.echo", "echo", [], execution);
  publications.publish("server-provider", 2);
  assert.equal(await registry.call("example.echo", "echo", [], execution), "server-two");

  let drained = false;
  const drain = registry.drainRuntime("server-provider", 1).then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  release?.();
  assert.equal(await oldCall, "server-one");
  await drain;
  assert.equal(drained, true);
  await assert.rejects(
    registry.call("example.echo", "echo", [], { ...execution, permissions: [] }),
    /not allowed/,
  );
});

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
  backend.onDrain = (generation) => {
    if (generation === 1) {
      supervisor.runtimeFailed("example.runtime", 2, new Error("candidate host crashed"));
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
