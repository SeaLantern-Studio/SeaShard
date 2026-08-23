import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteDatabaseBroker } from "../components/data/database-sqlite/src/index.ts";
import type { ExecutionContext } from "../packages/plugin-sdk/src/index.ts";
import { PluginRegistry } from "../packages/plugin-system/src/registry.ts";
import {
  AgentToolRegistry,
  ServiceRegistry,
} from "../packages/plugin-system/src/runtime-registries.ts";
import { PluginStore } from "../packages/plugin-system/src/store.ts";
import { databaseWorkerEntry, validManifest } from "./plugin-test-fixtures.ts";

await test("plugin system starts from the current package and Binding schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-store-"));
  const databasePath = join(directory, "seashard.sqlite3");
  let broker: SQLiteDatabaseBroker | undefined;

  try {
    broker = await SQLiteDatabaseBroker.create({
      databasePath,
      workerEntry: new URL("../apps/database-worker/dist/index.js", import.meta.url),
      readWorkers: 1,
    });
    await PluginStore.create(broker, "0.0.0");
    await broker.close();
    broker = undefined;

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const namespace = database
        .prepare(
          `SELECT version, compatibility_floor
             FROM seashard_schema_namespaces
            WHERE namespace = 'plugin_system'`,
        )
        .get() as { version: number; compatibility_floor: number };
      const currentTables = database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM sqlite_schema
            WHERE type = 'table'
              AND name IN ('plugin_packages', 'plugin_current', 'plugin_trust', 'plugin_bindings')`,
        )
        .get() as { count: number };
      const legacyTables = database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM sqlite_schema
            WHERE type = 'table'
              AND name IN (
                'plugin_runtime_counters',
                'plugin_runtime_generations',
                'plugin_runtime_publications',
                'plugin_runtime_operations',
                'operation_journal'
              )`,
        )
        .get() as { count: number };

      assert.equal(namespace.version, 1);
      assert.equal(namespace.compatibility_floor, 1);
      assert.equal(currentTables.count, 4);
      assert.equal(legacyTables.count, 0);
    } finally {
      database.close();
    }
  } finally {
    await broker?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("built-in inventory removes retired packages and bindings before reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-builtins-"));
  const broker = await SQLiteDatabaseBroker.create({
    databasePath: join(directory, "seashard.sqlite3"),
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });

  const registration = (pluginId: string, entryId: string, bindingId: string) => ({
    manifest: {
      ...validManifest,
      id: pluginId,
      entries: [
        {
          ...validManifest.entries[0]!,
          id: entryId,
          permissions: [],
        },
      ],
    },
    loaders: {
      [entryId]: { load: async () => ({}) },
    },
    bindings: [
      {
        id: bindingId,
        entryId,
        scopeType: "global" as const,
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });

  try {
    const store = await PluginStore.create(broker, "0.0.0");
    const previous = new PluginRegistry(store, "0.0.0");
    await previous.registerBuiltIn(
      registration("seashard.retired-builtin", "retired.host", "core.retired-builtin"),
    );

    const current = new PluginRegistry(store, "0.0.0");
    await current.registerBuiltIn(
      registration("seashard.current-builtin", "current.host", "core.current-builtin"),
    );
    await current.synchronizeBuiltIns();

    assert.deepEqual(
      (await store.listCurrentPackages()).map((record) => record.manifest.id),
      ["seashard.current-builtin"],
    );
    assert.deepEqual(await store.listBindings("seashard.retired-builtin"), []);
    assert.deepEqual(await store.listPackages("seashard.retired-builtin"), []);
    assert.equal(
      (await store.listBindings("seashard.current-builtin"))[0]?.id,
      "core.current-builtin",
    );
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("service registry selects the nearest active provider", async () => {
  const registry = new ServiceRegistry();
  const globalDispose = registry.register(
    "example.echo",
    "global-provider",
    { type: "global", id: "global" },
    { echo: () => "global" },
  );
  const serverDispose = registry.register(
    "example.echo",
    "server-provider",
    { type: "server", id: "server-a" },
    { echo: () => "server-one" },
  );
  const execution: ExecutionContext = {
    actorType: "plugin",
    actorId: "caller",
    runtimeId: "caller",
    scopeType: "server",
    scopeId: "server-a",
    scopeChain: [
      { type: "global", id: "global" },
      { type: "server", id: "server-a" },
    ],
    permissions: ["example.echo"],
    permissionRevision: 1,
  };

  assert.equal(await registry.call("example.echo", "echo", [], execution), "server-one");
  serverDispose();
  const replacementDispose = registry.register(
    "example.echo",
    "server-provider",
    { type: "server", id: "server-a" },
    { echo: () => "server-two" },
  );
  assert.equal(await registry.call("example.echo", "echo", [], execution), "server-two");
  await assert.rejects(
    registry.call("example.echo", "echo", [], { ...execution, permissions: [] }),
    /not allowed/,
  );
  replacementDispose();
  globalDispose();
});

await test("Agent tool registry rejects duplicates and invalidates Fiber snapshots", async () => {
  const registry = new AgentToolRegistry();
  const scope = { type: "global" as const, id: "global" };
  const definition = {
    namespace: "server",
    name: "list",
    title: "读取服务器列表",
    description: "读取已登记的服务器实例。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
  const registration = registry.register("server-manager", scope, definition, async () => ({
    count: 1,
  }));

  const [snapshot] = registry.snapshot();
  assert.equal(snapshot?.name, "server_list");
  assert.equal(registry.countRuntime("server-manager"), 1);
  assert.deepEqual(await snapshot?.execute({}, {}), { count: 1 });
  assert.throws(
    () => registry.register("duplicate-manager", scope, definition, async () => null),
    /server_list.*server-manager/,
  );

  registration.dispose();
  assert.deepEqual(registry.snapshot(), []);
  await assert.rejects(snapshot!.execute({}, {}), /Agent 工具已停止：server_list/);

  registry.register("replacement-manager", scope, definition, async () => null);
  registry.removeRuntime("replacement-manager");
  assert.equal(registry.countRuntime(), 0);
});
