import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteDatabaseBroker } from "../components/data/database-sqlite/src/index.ts";
import type { ExecutionContext, JsonValue } from "../packages/plugin-sdk/src/index.ts";
import { PluginRegistry } from "../packages/plugin-system/src/registry.ts";
import {
  AgentResourceRegistry,
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
    namespace: "test",
    name: "echo",
    title: "测试回显",
    description: "回显输入。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
  const registration = registry.register("test-handler", scope, definition, async (input) => input);

  const [snapshot] = registry.snapshot();
  assert.equal(snapshot?.name, "test_echo");
  assert.equal(registry.countRuntime("test-handler"), 1);
  assert.deepEqual(await snapshot?.execute({ value: 1 }, {}), { value: 1 });
  assert.throws(
    () => registry.register("duplicate-handler", scope, definition, async () => null),
    /test_echo.*test-handler/,
  );

  registration.dispose();
  assert.deepEqual(registry.snapshot(), []);
  await assert.rejects(snapshot!.execute({}, {}), /Agent 工具已停止：test_echo/);

  registry.register("replacement-handler", scope, definition, async () => null);
  registry.removeRuntime("replacement-handler");
  assert.equal(registry.countRuntime(), 0);
});

await test("Agent resource registry routes, validates domain input and invalidates snapshots", async () => {
  const registry = new AgentResourceRegistry();
  const scope = { type: "global" as const, id: "global" };
  let observed:
    | {
        readonly pathParams: Readonly<Record<string, string>>;
        readonly query: Readonly<Record<string, string>>;
        readonly input: JsonValue;
      }
    | undefined;
  const registration = registry.register(
    "server-runtime",
    scope,
    "server://instances/{instanceId}/logs",
    {
      description: "读取服务器日志。",
      inputSchema: {
        type: "object",
        properties: {
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["offset", "limit"],
        additionalProperties: false,
      },
      presentation: { title: "读取服务器日志", icon: "help" },
      implementation: {
        async read({ pathParams, uri, input }) {
          observed = {
            pathParams: { ...pathParams },
            query: { ...uri.query },
            input,
          };
          const options = input as { offset: number; limit: number };
          const lines = ["first", "second", "third"].slice(
            options.offset - 1,
            options.offset - 1 + options.limit,
          );
          return {
            mimeType: "application/json",
            content: {
              lines,
              pagination: {
                offset: options.offset,
                limit: options.limit,
                total: 3,
                hasMore: options.offset - 1 + lines.length < 3,
              },
            },
          };
        },
        presentRequest({ input }) {
          const options = input as { offset: number; limit: number };
          return [{ value: `${options.offset}～${options.offset + options.limit - 1}` }];
        },
        presentResult(_request, result) {
          const content = result.content as unknown as { lines: readonly JsonValue[] };
          return [{ value: String(content.lines.length), unit: "行" }];
        },
      },
    },
  );
  registry.register("server-runtime", scope, "server://instances/current/logs", {
    description: "读取当前服务器日志。",
    inputSchema: { type: "object", additionalProperties: false },
    implementation: {
      async read() {
        return { mimeType: "text/plain", content: "current" };
      },
    },
  });

  const snapshot = registry.snapshot();
  assert.equal(
    snapshot.definitions.find(({ pattern }) => pattern === "server://instances/current/logs")
      ?.presentation?.title,
    "读取资源",
  );
  assert.deepEqual(
    snapshot.definitions.find(({ pattern }) => pattern === "server://instances/{instanceId}/logs")
      ?.presentation,
    { title: "读取服务器日志", icon: "help" },
  );
  const prepared = snapshot.prepare("server://instances/server-a/logs?stream=stderr", {
    offset: 2,
    limit: 1,
  });
  assert.deepEqual(await prepared.presentRequest(), [{ value: "2～2" }]);
  const result = await prepared.read();
  assert.deepEqual(result, {
    mimeType: "application/json",
    content: {
      lines: ["second"],
      pagination: { offset: 2, limit: 1, total: 3, hasMore: true },
    },
  });
  assert.deepEqual(await prepared.presentResult(result), [{ value: "1", unit: "行" }]);
  assert.deepEqual(observed, {
    pathParams: { instanceId: "server-a" },
    query: { stream: "stderr" },
    input: { offset: 2, limit: 1 },
  });
  assert.deepEqual(await snapshot.read("server://instances/current/logs", {}), {
    mimeType: "text/plain",
    content: "current",
  });
  assert.throws(
    () =>
      snapshot.prepare("server://instances/server-a/logs", {
        offset: 0,
        limit: 1,
      }),
    /不符合 inputSchema/,
  );
  assert.throws(
    () =>
      registry.register("invalid-icon-runtime", scope, "invalid://", {
        description: "图标无效。",
        inputSchema: { type: "object" },
        presentation: { title: "无效图标", icon: "sparkles" as never },
        implementation: {
          async read() {
            return { mimeType: "text/plain", content: "" };
          },
        },
      }),
    /presentation\.icon 不受支持/u,
  );
  assert.throws(
    () =>
      registry.register("duplicate-runtime", scope, "server://instances/{name}/logs", {
        description: "重复路由。",
        inputSchema: { type: "object" },
        presentation: { title: "重复资源" },
        implementation: {
          async read() {
            return { mimeType: "text/plain", content: "" };
          },
        },
      }),
    /server:\/\/instances\/\{\*\}\/logs/,
  );
  await assert.rejects(
    snapshot.read("server://instances/%2E%2E/logs", {}),
    /Agent 资源 URI 路径不合法/,
  );

  registration.dispose();
  await assert.rejects(
    snapshot.read("server://instances/server-a/logs", { offset: 1, limit: 1 }),
    /Agent 资源已停止/,
  );
  registry.removeRuntime("server-runtime");
  assert.equal(registry.countRuntime(), 0);
});
