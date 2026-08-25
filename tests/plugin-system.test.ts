import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteDatabaseBroker } from "../components/data/database-sqlite/src/index.ts";
import type { ServiceResultValidationError } from "../packages/plugin-sdk/src/index.ts";
import type {
  ExecutionContext,
  JsonValue,
  PluginBinding,
  ServiceResultValidator,
} from "../packages/plugin-sdk/src/index.ts";
import type { ResolvedEntry } from "../packages/plugin-system/src/types.ts";
import {
  deserializeProtocolError,
  serializeProtocolError,
} from "../packages/plugin-system/src/host-protocol.ts";
import { PluginInstaller } from "../packages/plugin-system/src/installer.ts";
import {
  automaticPluginBindingId,
  automaticPluginBindingPrefix,
  PluginRegistry,
} from "../packages/plugin-system/src/registry.ts";
import { authorizeExternalServiceCall } from "../packages/plugin-system/src/runtime-backend.ts";
import {
  AgentProviderTypeRegistry,
  AgentResourceRegistry,
  AgentToolRegistry,
  ServiceRegistry,
} from "../packages/plugin-system/src/runtime-registries.ts";
import { PluginStore } from "../packages/plugin-system/src/store.ts";
import {
  databaseWorkerEntry,
  validManifest,
  validPluginPackageManifest,
} from "./plugin-test-fixtures.ts";

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

await test("directory installation persists an immutable trusted snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-directory-install-"));
  const sourceRoot = join(directory, "source");
  const modulePath = join(sourceRoot, "dist", "host.js");
  await mkdir(join(sourceRoot, "dist"), { recursive: true });
  await writeFile(
    join(sourceRoot, "plugin.json"),
    `${JSON.stringify(validPluginPackageManifest, null, 2)}\n`,
  );
  await writeFile(modulePath, "export const version = 1;\n");
  const broker = await SQLiteDatabaseBroker.create({
    databasePath: join(directory, "seashard.sqlite3"),
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });

  try {
    const store = await PluginStore.create(broker, "0.0.0");
    const installer = new PluginInstaller(store, directory, "0.0.0");
    const prepared = await installer.prepareDirectory(sourceRoot);
    const record = await prepared
      .commit({
        digest: prepared.digest,
        acknowledgeFullMachineAccess: true,
      })
      .finally(() => prepared.dispose());

    await writeFile(modulePath, "export const version = 2;\n");
    assert.equal(record.source, "installed");
    assert.notEqual(record.rootPath, sourceRoot);
    assert.equal(
      await readFile(join(record.rootPath, "dist", "host.js"), "utf8"),
      "export const version = 1;\n",
    );
    assert.equal(
      (await store.listPackages(validPluginPackageManifest.id))[0]?.digest,
      record.digest,
    );
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("third-party bindings are global without changing internal scope support", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-binding-scope-"));
  const broker = await SQLiteDatabaseBroker.create({
    databasePath: join(directory, "seashard.sqlite3"),
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });

  try {
    const store = await PluginStore.create(broker, "0.0.0");
    const registry = new PluginRegistry(store, "0.0.0");
    await registry.registerBuiltIn({
      manifest: {
        ...validManifest,
        entries: [
          {
            ...validManifest.entries[0]!,
            activationScopes: ["global", "server"],
          },
        ],
      },
      loaders: {
        "example.host": { load: async () => ({}) },
      },
      bindings: [],
    });

    await registry.upsertGlobalBinding({
      id: "external.global",
      pluginId: validManifest.id,
      entryId: "example.host",
      enabled: true,
      config: null,
    });
    for (const id of [
      `plugin:${validManifest.id}:example.host`,
      `dev:${validManifest.id}:example.host`,
    ]) {
      await assert.rejects(
        registry.upsertGlobalBinding({
          id,
          pluginId: validManifest.id,
          entryId: "example.host",
          enabled: true,
          config: null,
        }),
        /reserved automatic namespace/,
      );
    }
    await registry.upsertBinding({
      id: "internal.server",
      pluginId: validManifest.id,
      entryId: "example.host",
      scopeType: "server",
      scopeId: "server-a",
      enabled: true,
      config: null,
    });

    assert.deepEqual(await registry.listBindings(validManifest.id), [
      {
        id: "external.global",
        pluginId: validManifest.id,
        entryId: "example.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
      {
        id: "internal.server",
        pluginId: validManifest.id,
        entryId: "example.host",
        scopeType: "server",
        scopeId: "server-a",
        enabled: true,
        config: null,
      },
    ]);
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("external service calls use Main identity and method declarations", () => {
  const manifest = {
    ...validManifest,
    entries: [
      {
        ...validManifest.entries[0]!,
        uses: {
          "example.echo": ["read"],
        },
      },
    ],
  };
  const entry: ResolvedEntry = {
    package: {
      manifest,
      digest: "a".repeat(64),
      rootPath: "C:/plugins/example.plugin",
      source: "installed",
      trust: "package-full-trust",
      installedAt: "2026-08-24T00:00:00.000Z",
    },
    entry: manifest.entries[0]!,
    binding: {
      id: "external.example",
      pluginId: manifest.id,
      entryId: manifest.entries[0]!.id,
      scopeType: "global",
      scopeId: "global",
      enabled: true,
      config: null,
    },
    runtimeId: "external.example",
    host: "node-plugin-host",
  };
  const trustedExecution: ExecutionContext = {
    actorType: "plugin",
    actorId: manifest.id,
    runtimeId: entry.runtimeId,
    scopeType: "global",
    scopeId: "global",
    scopeChain: [{ type: "global", id: "global" }],
    permissions: ["example.echo"],
    permissionRevision: 1,
  };
  const forgedExecution: ExecutionContext = {
    actorType: "core",
    actorId: "seashard.core",
    scopeType: "global",
    scopeId: "global",
    scopeChain: [{ type: "global", id: "global" }],
    permissions: ["*"],
    permissionRevision: 999,
  };

  const authorized = authorizeExternalServiceCall(entry, trustedExecution, {
    contract: "example.echo",
    method: "read",
    args: [],
    execution: forgedExecution,
  } as unknown as JsonValue);
  assert.equal(authorized.execution, trustedExecution);
  assert.deepEqual(
    {
      contract: authorized.contract,
      method: authorized.method,
      args: authorized.args,
    },
    {
      contract: "example.echo",
      method: "read",
      args: [],
    },
  );

  assert.throws(
    () =>
      authorizeExternalServiceCall(entry, trustedExecution, {
        contract: "example.echo",
        method: "write",
        args: [],
      }),
    /did not declare example\.echo\.write/,
  );
  assert.throws(
    () =>
      authorizeExternalServiceCall(entry, trustedExecution, {
        contract: "example.admin",
        method: "deleteAll",
        args: [],
      }),
    /did not declare example\.admin\.deleteAll/,
  );
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

await test("service result validation is optional and bound to the selected registration", async () => {
  const registry = new ServiceRegistry();
  const execution: ExecutionContext = {
    actorType: "core",
    actorId: "seashard.core",
    scopeType: "global",
    scopeId: "global",
    scopeChain: [{ type: "global", id: "global" }],
    permissions: ["*"],
    permissionRevision: 1,
  };
  let result: JsonValue = { count: 1 };
  const resultValidators: Record<string, ServiceResultValidator> = {
    read: {
      validate(value) {
        const count =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>).count
            : undefined;
        return typeof count === "number" && count >= 0
          ? []
          : [{ path: ["count"], message: "count must be non-negative" }];
      },
    },
  };
  const dispose = registry.register(
    "example.catalog",
    "catalog-provider",
    { type: "global", id: "global" },
    {
      read: () => result,
      unchecked: () => ({ count: -1 }),
    },
    { resultValidators },
  );

  assert.equal(await registry.call("example.catalog", "read", [], execution), result);
  assert.deepEqual(await registry.call("example.catalog", "unchecked", [], execution), {
    count: -1,
  });

  delete resultValidators.read;
  result = { count: -1 };
  let validationFailure: ServiceResultValidationError | undefined;
  await assert.rejects(
    registry.call("example.catalog", "read", [], execution),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.name, "ServiceResultValidationError");
      const validationError = error as ServiceResultValidationError;
      validationFailure = validationError;
      assert.equal(validationError.runtimeId, "catalog-provider");
      assert.equal(validationError.contract, "example.catalog");
      assert.equal(validationError.method, "read");
      assert.deepEqual(validationError.issues, [
        { path: ["count"], message: "count must be non-negative" },
      ]);
      return true;
    },
  );
  dispose();
  const prototypeSafeRegistry = new ServiceRegistry();
  prototypeSafeRegistry.register(
    "example.prototype-safe",
    "prototype-safe-provider",
    { type: "global", id: "global" },
    {
      read: () => "read",
      toString: () => "provider-to-string",
    },
  );
  assert.equal(
    await prototypeSafeRegistry.call("example.prototype-safe", "toString", [], execution),
    "provider-to-string",
  );
  await assert.rejects(
    prototypeSafeRegistry.call("example.prototype-safe", "hasOwnProperty", [], execution),
    /method does not exist/u,
  );

  assert.throws(
    () =>
      registry.register(
        "example.invalid",
        "invalid-provider",
        { type: "global", id: "global" },
        { read: () => null },
        {
          resultValidators: {
            missing: { validate: () => [] },
          },
        },
      ),
    /targets a missing method/u,
  );
  assert.throws(
    () =>
      registry.register(
        "example.inherited",
        "invalid-provider",
        { type: "global", id: "global" },
        { read: () => null },
        {
          resultValidators: {
            toString: { validate: () => [] },
          },
        },
      ),
    /targets a missing method/u,
  );

  assert(validationFailure);
  const remoteError = deserializeProtocolError(serializeProtocolError(validationFailure));
  assert.equal(remoteError.name, "ServiceResultValidationError");
  const remoteValidationError = remoteError as ServiceResultValidationError;
  assert.equal(remoteValidationError.runtimeId, "catalog-provider");
  assert.equal(remoteValidationError.contract, "example.catalog");
  assert.equal(remoteValidationError.method, "read");
  assert.deepEqual(remoteValidationError.issues, [
    { path: ["count"], message: "count must be non-negative" },
  ]);
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

await test("AI Provider Type registry validates settings and invalidates Fiber snapshots", () => {
  const registry = new AgentProviderTypeRegistry();
  const scope = { type: "global" as const, id: "global" };
  let changes = 0;
  registry.onChanged(() => {
    changes += 1;
  });
  const registration = registry.register("provider-runtime", scope, {
    id: "test-provider",
    displayName: "Test Provider",
    settingsSchema: {
      type: "object",
      properties: {
        baseURL: { type: "string", minLength: 1 },
      },
      required: ["baseURL"],
      additionalProperties: false,
    },
    catalog: [{ id: "test-model", displayName: "Test Model" }],
    create: ({ connectionId, settings }) => ({ connectionId, settings }),
  });

  const snapshot = registry.snapshot().resolve("test-provider");
  assert(snapshot);
  snapshot.validateSettings({ baseURL: "http://127.0.0.1/v1" });
  assert.throws(() => snapshot.validateSettings({}), /baseURL/u);
  assert.deepEqual(
    snapshot.create({
      connectionId: "local",
      settings: { baseURL: "http://127.0.0.1/v1" },
    }),
    {
      connectionId: "local",
      settings: { baseURL: "http://127.0.0.1/v1" },
    },
  );
  assert.equal(registry.countRuntime("provider-runtime"), 1);
  assert.equal(changes, 1);

  registration.dispose();
  assert.equal(changes, 2);
  assert.equal(registry.snapshot().resolve("test-provider"), undefined);
  assert.throws(
    () =>
      snapshot.create({
        connectionId: "local",
        settings: { baseURL: "http://127.0.0.1/v1" },
      }),
    /AI Provider Type 已停止/u,
  );
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

await test("development package overlays stay in memory and replace their complete Entry set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-development-overlay-"));
  const broker = await SQLiteDatabaseBroker.create({
    databasePath: join(directory, "seashard.sqlite3"),
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });

  try {
    const store = await PluginStore.create(broker, "0.0.0");
    const registry = new PluginRegistry(store, "0.0.0");
    const persisted = {
      manifest: validManifest,
      digest: "a".repeat(64),
      rootPath: "C:/plugins/example.plugin",
      source: "installed" as const,
      trust: "package-full-trust" as const,
      installedAt: "2026-08-25T00:00:00.000Z",
    };
    await store.registerPackage(persisted);
    await store.setCurrentVersion(
      persisted.manifest.id,
      persisted.manifest.version,
      persisted.digest,
    );
    await registry.upsertGlobalBinding({
      id: "plugin.example.persisted",
      pluginId: persisted.manifest.id,
      entryId: persisted.manifest.entries[0]!.id,
      enabled: true,
      config: null,
    });

    const firstDevelopment = {
      ...persisted,
      manifest: {
        ...validManifest,
        version: "2.0.0",
        entries: [
          {
            ...validManifest.entries[0]!,
            id: "development.host",
          },
        ],
      },
      digest: "b".repeat(64),
      rootPath: "C:/work/example.plugin",
      source: "development" as const,
      trust: "local-full-trust" as const,
    };
    registry.setDevelopmentPackage(firstDevelopment);
    const firstResolved = await registry.resolve({
      hostProfile: "electron",
      clientTarget: "desktop",
      platform: "win32",
      architecture: "x64",
    });
    assert.deepEqual(
      firstResolved.map((entry) => [entry.runtimeId, entry.entry.id, entry.package.digest]),
      [[`dev:${validManifest.id}:development.host`, "development.host", firstDevelopment.digest]],
    );

    const secondDevelopment = {
      ...firstDevelopment,
      manifest: {
        ...firstDevelopment.manifest,
        entries: [
          {
            ...validManifest.entries[0]!,
            id: "replacement.host",
          },
        ],
      },
      digest: "c".repeat(64),
    };
    registry.setDevelopmentPackage(secondDevelopment, firstDevelopment.manifest.id);
    const secondResolved = await registry.resolve({
      hostProfile: "electron",
      clientTarget: "desktop",
      platform: "win32",
      architecture: "x64",
    });
    assert.deepEqual(
      secondResolved.map((entry) => [entry.runtimeId, entry.entry.id, entry.package.digest]),
      [[`dev:${validManifest.id}:replacement.host`, "replacement.host", secondDevelopment.digest]],
    );

    registry.clearDevelopmentPackages();
    const restored = await registry.resolve({
      hostProfile: "electron",
      clientTarget: "desktop",
      platform: "win32",
      architecture: "x64",
    });
    assert.deepEqual(
      restored.map((entry) => [entry.runtimeId, entry.package.digest]),
      [["plugin.example.persisted", persisted.digest]],
    );
    assert.deepEqual(
      (await store.listBindings(validManifest.id)).map((binding) => binding.id),
      ["plugin.example.persisted"],
    );
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("package selection and automatic Binding replacement roll back atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-package-binding-transaction-"));
  const broker = await SQLiteDatabaseBroker.create({
    databasePath: join(directory, "seashard.sqlite3"),
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });

  try {
    const store = await PluginStore.create(broker, "0.0.0");
    const previous = {
      manifest: validManifest,
      digest: "d".repeat(64),
      rootPath: "C:/plugins/example.plugin/1.0.0",
      source: "installed" as const,
      trust: "package-full-trust" as const,
      installedAt: "2026-08-25T00:00:00.000Z",
    };
    const next = {
      ...previous,
      manifest: {
        ...validManifest,
        version: "2.0.0",
      },
      digest: "e".repeat(64),
      rootPath: "C:/plugins/example.plugin/2.0.0",
    };
    const prefix = automaticPluginBindingPrefix("plugin", validManifest.id);
    const previousBinding: PluginBinding = {
      id: `${prefix}${validManifest.entries[0]!.id}`,
      pluginId: validManifest.id,
      entryId: validManifest.entries[0]!.id,
      scopeType: "global",
      scopeId: "global",
      enabled: true,
      config: {},
    };
    await store.registerPackage(previous);
    await store.registerPackage(next);
    await store.setCurrentVersion(previous.manifest.id, previous.manifest.version, previous.digest);
    await store.upsertBinding(previousBinding);

    const invalidBinding = {
      ...previousBinding,
      id: null,
    } as unknown as PluginBinding;
    await assert.rejects(
      store.replaceCurrentPackageBindings(validManifest.id, next, prefix, [invalidBinding]),
      /NOT NULL|constraint/i,
    );

    assert.deepEqual(
      (await store.listCurrentPackages()).map((record) => [record.manifest.version, record.digest]),
      [[previous.manifest.version, previous.digest]],
    );
    assert.deepEqual(await store.listBindings(validManifest.id), [previousBinding]);
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("automatic Binding IDs preserve dotted Manifest boundaries", () => {
  assert.notEqual(
    automaticPluginBindingId("plugin", "acme.foo", "bar"),
    automaticPluginBindingId("plugin", "acme", "foo.bar"),
  );
  assert.equal(automaticPluginBindingId("plugin", "a".repeat(128), "b".repeat(128)).length, 264);
});
