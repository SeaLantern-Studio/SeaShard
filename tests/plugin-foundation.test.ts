import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BootstrapLoader } from "../packages/bootstrap-runtime/src/index.ts";
import {
  createSQLiteBootstrapDescriptor,
  SQLiteDatabaseBroker,
} from "../components/data/database-sqlite/src/index.ts";
import { createPluginFoundationBootstrapDescriptor } from "../components/plugin/foundation/src/index.ts";
import { defineDataCapsule } from "../packages/database/src/index.ts";
import type { ExecutionContext } from "../packages/plugin-sdk/src/index.ts";
import { Context } from "cordis";
import { databaseWorkerEntry } from "./plugin-test-fixtures.ts";

await test("plugin foundation boots after database and repairs persisted runtime state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-foundation-"));
  const descriptors = () => [
    createPluginFoundationBootstrapDescriptor({
      dataRoot: directory,
      workerEntry: databaseWorkerEntry,
      seaShardVersion: "0.0.0",
    }),
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
        ["seashard.database-sqlite", "seashard.plugin-foundation"],
      );

      const store = firstRoot["plugin-foundation"].store;
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
      const store = secondRoot["plugin-foundation"].store;
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

await test("plugin foundation exposes managed storage with runtime isolation and revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-storage-"));
  const root = new Context();
  const loader = new BootstrapLoader(root);
  try {
    await loader.start([
      createPluginFoundationBootstrapDescriptor({
        dataRoot: directory,
        workerEntry: databaseWorkerEntry,
        seaShardVersion: "0.0.0",
      }),
      createSQLiteBootstrapDescriptor({
        dataRoot: directory,
        workerEntry: databaseWorkerEntry,
        readWorkers: 1,
      }),
    ]);
    assert.deepEqual(
      loader.snapshot().map((component) => component.id),
      ["seashard.database-sqlite", "seashard.plugin-foundation"],
    );

    const storage = root["plugin-foundation"].storage;
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
