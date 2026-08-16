import assert from "node:assert/strict";
import { BootstrapLoader } from "../packages/bootstrap-runtime/src/index.ts";
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
import {
  createSQLiteBootstrapDescriptor,
  SQLiteDatabaseBroker,
} from "../components/database-sqlite/src/index.ts";
import { defineDataCapsule } from "../packages/database/src/index.ts";
import { createPluginSystemFoundationBootstrapDescriptor } from "../components/plugin-system-foundation/src/index.ts";
import { createSQLitePluginStorageBootstrapDescriptor } from "../components/plugin-storage-sqlite/src/index.ts";
import { projectRuntimeSnapshot } from "../components/runtime-diagnostics/src/index.ts";
import type {
  ExecutionContext,
  JsonValue,
  PluginManifest,
  RuntimeGenerationSnapshot,
  RuntimeControlSnapshot,
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
import { Context } from "cordis";
const databaseWorkerEntry = new URL("../apps/database-worker/dist/index.js", import.meta.url);

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

await test("runtime diagnostics projects publications, operations, and host state", () => {
  const generation = (
    runtimeId: string,
    generationNumber: number,
    phase: RuntimeGenerationSnapshot["phase"],
  ): RuntimeGenerationSnapshot => ({
    runtimeId,
    pluginId: `plugin.${runtimeId}`,
    pluginVersion: "1.0.0",
    entryId: "host",
    bindingId: runtimeId,
    source: "builtin",
    trust: "builtin",
    scopeType: "global",
    scopeId: "global",
    generation: generationNumber,
    phase,
    upgradeMode: "hot-swap",
    host: "core",
    dependencies: [],
  });
  const operation = (
    runtimeId: string,
    status: RuntimeOperationSnapshot["status"],
    step: RuntimeOperationSnapshot["step"],
    error?: string,
  ): RuntimeOperationSnapshot => ({
    id: `operation.${runtimeId}`,
    runtimeId,
    kind: "activate",
    mode: "hot-swap",
    status,
    step,
    currentGeneration: null,
    candidateGeneration: 1,
    attentionRequired: false,
    ...(error ? { error } : {}),
  });
  const control: RuntimeControlSnapshot = {
    generations: [
      generation("active", 1, "running"),
      generation("active", 2, "failed"),
      generation("blocked", 1, "prepared"),
      generation("failed", 1, "failed"),
      generation("retired", 1, "terminated"),
      generation("updating", 1, "prepared"),
    ],
    publications: [{ runtimeId: "active", generation: 1, epoch: 1 }],
    operations: [
      operation("active", "running", "start-candidate"),
      operation("blocked", "running", "wait-dependencies"),
      operation("failed", "failed", "prepare", "candidate failed"),
      operation("retired", "completed", "stop-previous"),
      operation("updating", "running", "prepare"),
    ],
  };

  const snapshot = projectRuntimeSnapshot(control, {
    host: "electron",
    startedAt: "2026-08-16T00:00:00.000Z",
    stopping: false,
  });
  assert.equal(snapshot.state, "degraded");
  assert.deepEqual(
    snapshot.components.map(({ id, generation: number, phase }) => ({ id, number, phase })),
    [
      { id: "active", number: 1, phase: "active" },
      { id: "blocked", number: 1, phase: "blocked" },
      { id: "failed", number: 1, phase: "failed" },
      { id: "updating", number: 1, phase: "updating" },
    ],
  );
  assert.equal(
    snapshot.components.find((component) => component.id === "failed")?.error,
    "candidate failed",
  );

  const stopping = projectRuntimeSnapshot(control, {
    host: "electron",
    startedAt: snapshot.startedAt,
    stopping: true,
  });
  assert.equal(stopping.state, "stopping");
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
    CREATE TABLE plugin_current (
      plugin_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      digest TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (plugin_id, version, digest)
        REFERENCES plugin_packages(plugin_id, version, digest) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE plugin_trust (
      plugin_id TEXT NOT NULL,
      version TEXT NOT NULL,
      digest TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_root TEXT NOT NULL,
      trust_level TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, version, digest)
    ) STRICT;
    CREATE TABLE plugin_bindings (
      id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE plugin_runtime_units (
      runtime_id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL DEFAULT 'legacy',
      plugin_version TEXT NOT NULL DEFAULT 'legacy',
      entry_id TEXT NOT NULL DEFAULT 'legacy',
      binding_id TEXT NOT NULL DEFAULT 'legacy',
      source_kind TEXT NOT NULL DEFAULT 'installed',
      trust_level TEXT NOT NULL DEFAULT 'package-full-trust',
      scope_type TEXT NOT NULL DEFAULT 'global',
      scope_id TEXT NOT NULL DEFAULT 'global',
      generation INTEGER NOT NULL,
      desired_state TEXT NOT NULL DEFAULT 'running',
      actual_state TEXT NOT NULL DEFAULT 'running',
      reload_policy TEXT NOT NULL DEFAULT 'quiesce',
      host_kind TEXT NOT NULL DEFAULT 'node-plugin-host',
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      updated_at TEXT NOT NULL DEFAULT 'legacy'
    ) STRICT;
    CREATE TABLE operation_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      category TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX plugin_bindings_plugin_idx ON plugin_bindings(plugin_id);
    CREATE INDEX runtime_units_binding_idx ON plugin_runtime_units(binding_id);
    CREATE INDEX journal_aggregate_idx ON operation_journal(aggregate_id, id);
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

  let broker: SQLiteDatabaseBroker | undefined;
  try {
    broker = await SQLiteDatabaseBroker.create({
      databasePath,
      workerEntry: new URL("../apps/database-worker/dist/index.js", import.meta.url),
      readWorkers: 1,
    });
    const store = await PluginStore.create(broker, "0.0.0");
    assert.equal((await store.listPackages())[0]?.manifest.entries[0]?.upgradeMode, "stop-first");
    assert.equal(await store.nextGeneration("example.runtime"), 8);
    assert.deepEqual(await store.listRuntimeGenerations(), []);
  } finally {
    await broker?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("plugin system foundation boots after database and repairs persisted runtime state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-foundation-"));
  const descriptors = () => [
    createPluginSystemFoundationBootstrapDescriptor({ seaShardVersion: "0.0.0" }),
    createSQLiteBootstrapDescriptor({
      dataRoot: directory,
      workerEntry: databaseWorkerEntry,
      readWorkers: 1,
    }),
  ];

  try {
    const firstRoot = new Context();
    const firstLoader = new BootstrapLoader(firstRoot);
    try {
      await firstLoader.start(descriptors());
      assert.deepEqual(
        firstLoader.snapshot().map((component) => component.id),
        ["seashard.database-sqlite", "seashard.plugin-system-foundation"],
      );

      const store = firstRoot["plugin-system-foundation"].store;
      await store.saveRuntimePublication({
        runtimeId: "example.runtime",
        generation: 3,
        epoch: 7,
      });
      await store.saveRuntimeOperation({
        id: "operation-1",
        runtimeId: "example.runtime",
        kind: "reload",
        mode: "stop-first",
        status: "running",
        step: "prepare",
        currentGeneration: 3,
        candidateGeneration: 4,
        attentionRequired: false,
      });
    } finally {
      await firstLoader.dispose();
    }

    const secondRoot = new Context();
    const secondLoader = new BootstrapLoader(secondRoot);
    try {
      await secondLoader.start(descriptors());
      const store = secondRoot["plugin-system-foundation"].store;
      const publication = (await store.listRuntimePublications())[0];
      assert.equal(publication?.generation, null);
      assert.equal(publication?.epoch, 8);
      const operation = (await store.listRuntimeOperations())[0];
      assert.equal(operation?.status, "interrupted");
      assert.match(operation?.error ?? "", /stopped before the operation completed/);
    } finally {
      await secondLoader.dispose();
    }
  } finally {
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

await test("failed worker migration rolls back before a corrected retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-migration-"));
  const databasePath = join(directory, "migration.sqlite3");
  const failing = defineDataCapsule({
    namespace: "test_migration",
    schemaVersion: 1,
    compatibilityFloor: 1,
    tables: ["test_migration_records"],
    migrations: [
      {
        version: 1,
        statements: [
          "CREATE TABLE test_migration_records (value INTEGER NOT NULL) STRICT",
          "INSERT INTO test_migration_records (value) VALUES (0)",
        ],
        verify: [
          {
            sql: "SELECT value AS valid FROM test_migration_records",
            column: "valid",
            equals: 1,
          },
        ],
      },
    ],
    commands: [],
  });
  const corrected = defineDataCapsule({
    namespace: "test_migration",
    schemaVersion: 1,
    compatibilityFloor: 1,
    tables: ["test_migration_records"],
    migrations: [
      {
        version: 1,
        statements: [
          "CREATE TABLE test_migration_records (value INTEGER NOT NULL) STRICT",
          "INSERT INTO test_migration_records (value) VALUES (1)",
        ],
        verify: [
          {
            sql: "SELECT value AS valid FROM test_migration_records",
            column: "valid",
            equals: 1,
          },
        ],
      },
    ],
    commands: [
      {
        id: "record.get",
        access: "read",
        result: "get",
        sql: "SELECT value FROM test_migration_records",
      },
      {
        id: "schema.read",
        access: "read",
        result: "all",
        sql: "SELECT name FROM sqlite_schema",
      },
    ],
  });

  const broker = await SQLiteDatabaseBroker.create({
    databasePath,
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });
  try {
    await assert.rejects(broker.registerCapsule(failing), /migration verification failed/);
    const repository = await broker.registerCapsule(corrected);
    const result = await repository.execute("record.get");
    assert.equal(result.kind, "get");
    assert.equal(result.kind === "get" ? result.row?.value : undefined, 1);
    await assert.rejects(repository.execute("schema.read"), /prohibited|not authorized/);
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("managed plugin storage boots separately, isolates runtimes, and rejects stale revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-storage-"));
  const root = new Context();
  const loader = new BootstrapLoader(root);
  try {
    await loader.start([
      createSQLitePluginStorageBootstrapDescriptor({
        dataRoot: directory,
        workerEntry: databaseWorkerEntry,
      }),
      createSQLiteBootstrapDescriptor({
        dataRoot: directory,
        workerEntry: databaseWorkerEntry,
        readWorkers: 1,
      }),
    ]);
    assert.deepEqual(
      loader.snapshot().map((component) => component.id),
      ["seashard.database-sqlite", "seashard.plugin-storage-sqlite"],
    );

    const storage = root["plugin-storage"];
    const baseExecution: ExecutionContext = {
      actorType: "plugin",
      actorId: "example.plugin",
      runtimeId: "example.runtime-a",
      generation: 1,
      scopeType: "global",
      scopeId: "global",
      scopeChain: [{ type: "global", id: "global" }],
      permissions: [],
      permissionRevision: 1,
    };
    const runtimeA = storage.for(baseExecution);
    const runtimeB = storage.for({
      ...baseExecution,
      runtimeId: "example.runtime-b",
    });

    const first = await runtimeA.put("state/session", { owner: "a" }, { expectedRevision: null });
    assert.equal(first.revision, 1);
    assert.equal(await runtimeB.get("state/session"), undefined);
    await runtimeB.put("state/session", { owner: "b" }, { expectedRevision: null });
    assert.deepEqual((await runtimeA.get("state/session"))?.value, { owner: "a" });
    assert.deepEqual((await runtimeB.get("state/session"))?.value, { owner: "b" });

    await assert.rejects(
      runtimeA.put("state/session", { owner: "stale" }, { expectedRevision: 99 }),
      /revision conflict/,
    );
    const second = await runtimeA.put(
      "state/session",
      { owner: "updated" },
      { expectedRevision: first.revision },
    );
    assert.equal(second.revision, 2);
    assert.equal(await runtimeA.delete("state/session", { expectedRevision: 1 }), false);
    assert.equal(await runtimeA.delete("state/session", { expectedRevision: 2 }), true);
  } finally {
    await loader.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
