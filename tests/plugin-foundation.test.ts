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
import type {
  ExecutionContext,
  PluginContext,
  PluginManifest,
} from "../packages/plugin-sdk/src/index.ts";
import { PluginKernel } from "../packages/plugin-system/src/kernel.ts";
import { Context } from "cordis";
import { databaseWorkerEntry } from "./plugin-test-fixtures.ts";

await test("plugin foundation keeps only package and Binding persistence", async () => {
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
    const root = new Context();
    const loader = new BootstrapLoader(root);
    try {
      await loader.start(descriptors());
      assert.deepEqual(
        loader.snapshot().map((component) => component.id),
        ["seashard.database-sqlite", "seashard.plugin-foundation"],
      );
      assert.deepEqual(await root["plugin-foundation"].store.listBindings(), []);
      assert.deepEqual(await root["plugin-foundation"].store.listCurrentPackages(), []);
    } finally {
      await loader.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("built-in Agent tools follow Cordis Fiber reload and disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-agent-tool-fiber-"));
  const root = new Context();
  const loader = new BootstrapLoader(root);
  let kernel: PluginKernel | undefined;
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
    kernel = await PluginKernel.create({
      dataRoot: directory,
      seaShardVersion: "0.0.0",
      pluginHostEntry: "unused-plugin-host.js",
      hostProfile: "node",
      platform: "win32",
      architecture: "x64",
      root,
      store: root["plugin-foundation"].store,
      pluginStorage: root["plugin-foundation"].storage,
    });
    const manifest = {
      id: "seashard.test-agent-tool",
      version: "0.0.0",
      publisher: "seashard-tests",
      entries: [
        {
          id: "agent-tool.host",
          runtime: "host",
          module: "./dist/host.js",
          hostProfiles: ["node"],
          activationScopes: ["global"],
          permissions: [],
        },
      ],
      compatibility: { seaShard: ">=0.0.0 <1.0.0" },
    } satisfies PluginManifest;
    await kernel.registerBuiltIn({
      manifest,
      loaders: {
        "agent-tool.host": {
          load: async () => ({
            apply(ctx: PluginContext) {
              ctx.agentTool(
                {
                  namespace: "test",
                  name: "echo",
                  title: "测试回显",
                  description: "回显测试输入。",
                  inputSchema: { type: "object" },
                },
                async (input) => input,
              );
            },
          }),
        },
      },
      bindings: [
        {
          id: "test.agent-tool",
          entryId: "agent-tool.host",
          scopeType: "global",
          scopeId: "global",
          enabled: true,
          config: null,
        },
      ],
    });
    await kernel.start();

    const beforeReload = kernel.agentTools.snapshot()[0]!;
    assert.equal(beforeReload.name, "test_echo");
    assert.deepEqual(await beforeReload.execute({ value: "before" }, {}), { value: "before" });

    await kernel.reload("test.agent-tool");
    assert.equal(kernel.agentTools.snapshot().length, 1);
    await assert.rejects(beforeReload.execute({ value: "stale" }, {}), /Agent 工具已停止/);

    await kernel.dispose();
    assert.equal(kernel.agentTools.snapshot().length, 0);
  } finally {
    await kernel?.dispose();
    await loader.dispose();
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
