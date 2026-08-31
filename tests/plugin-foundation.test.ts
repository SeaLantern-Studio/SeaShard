import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
  PluginPackageManifest,
} from "../packages/plugin-sdk/src/index.ts";
import { PluginKernel } from "../packages/plugin-system/src/kernel.ts";
import type { PluginPackageRecord } from "../packages/plugin-system/src/types.ts";
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

await test("built-in Agent capabilities follow Cordis Fiber reload and disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-agent-capability-fiber-"));
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
              ctx.agentResources({
                "test://state/{name}": {
                  description: "读取测试状态。",
                  inputSchema: {
                    type: "object",
                    additionalProperties: false,
                  },
                  presentation: { title: "读取测试状态" },
                  implementation: {
                    async read({ pathParams }) {
                      return {
                        mimeType: "text/plain",
                        content: pathParams.name!,
                      };
                    },
                  },
                },
              });
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
    const resourcesBeforeReload = kernel.agentResources.snapshot();
    assert.deepEqual(await resourcesBeforeReload.read("test://state/before", {}), {
      mimeType: "text/plain",
      content: "before",
    });

    await kernel.reload("test.agent-tool");
    assert.equal(kernel.agentTools.snapshot().length, 1);
    await assert.rejects(beforeReload.execute({ value: "stale" }, {}), /Agent 工具已停止/);
    assert.equal(kernel.agentResources.snapshot().definitions.length, 1);
    await assert.rejects(resourcesBeforeReload.read("test://state/stale", {}), /Agent 资源已停止/);

    await kernel.dispose();
    assert.equal(kernel.agentTools.snapshot().length, 0);
    assert.equal(kernel.agentResources.snapshot().definitions.length, 0);
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

await test("plugin document migration is replay-safe and marks the source after import", async () => {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "seashard-storage-source-"));
  const targetDirectory = await mkdtemp(join(tmpdir(), "seashard-storage-target-"));
  const sourceRoot = new Context();
  const targetRoot = new Context();
  const sourceLoader = new BootstrapLoader(sourceRoot);
  const targetLoader = new BootstrapLoader(targetRoot);
  const descriptor = (dataRoot: string) => [
    createPluginFoundationBootstrapDescriptor({
      dataRoot,
      workerEntry: databaseWorkerEntry,
      seaShardVersion: "0.0.0",
    }),
    createSQLiteBootstrapDescriptor({
      dataRoot,
      workerEntry: databaseWorkerEntry,
      readWorkers: 1,
    }),
  ];
  const execution: ExecutionContext = {
    actorType: "plugin",
    actorId: "example.migrated-plugin",
    runtimeId: "plugin:example.migrated-plugin:worker",
    scopeType: "global",
    scopeId: "global",
    scopeChain: [{ type: "global", id: "global" }],
    permissions: [],
    permissionRevision: 1,
  };

  try {
    await sourceLoader.start(descriptor(sourceDirectory));
    await targetLoader.start(descriptor(targetDirectory));
    const source = sourceRoot["plugin-foundation"].storage;
    const target = targetRoot["plugin-foundation"].storage;
    await source.for(execution).put("state/value", { origin: "source" });
    await target.for(execution).put("state/preserved", { origin: "target" });

    const rows = await source.exportOwners([execution.actorId]);
    await target.importDocuments(rows);
    await target.importDocuments(rows);
    await source.completeMigration({
      migrationId: "test-host-to-controller-v1",
      targetId: "controller-test",
      documentCount: rows.length,
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    await source.completeMigration({
      migrationId: "test-host-to-controller-v1",
      targetId: "ignored-replay",
      documentCount: 99,
      completedAt: "2026-01-02T00:00:00.000Z",
    });

    assert.deepEqual((await target.for(execution).get("state/value"))?.value, {
      origin: "source",
    });
    assert.deepEqual((await target.for(execution).get("state/preserved"))?.value, {
      origin: "target",
    });
    assert.deepEqual(await source.readMigrationMarker("test-host-to-controller-v1"), {
      migrationId: "test-host-to-controller-v1",
      targetId: "controller-test",
      documentCount: rows.length,
      completedAt: "2026-01-01T00:00:00.000Z",
    });
  } finally {
    await targetLoader.dispose();
    await sourceLoader.dispose();
    await rm(targetDirectory, { recursive: true, force: true });
    await rm(sourceDirectory, { recursive: true, force: true });
  }
});

await test("Controller and Host kernels activate only their declared Entry locations", async () => {
  const controllerDirectory = await mkdtemp(join(tmpdir(), "seashard-controller-entry-"));
  const hostDirectory = await mkdtemp(join(tmpdir(), "seashard-host-entry-"));
  const controllerRoot = new Context();
  const hostRoot = new Context();
  const controllerLoader = new BootstrapLoader(controllerRoot);
  const hostLoader = new BootstrapLoader(hostRoot);
  let controller: PluginKernel | undefined;
  let host: PluginKernel | undefined;
  const descriptor = (dataRoot: string) => [
    createPluginFoundationBootstrapDescriptor({
      dataRoot,
      workerEntry: databaseWorkerEntry,
      seaShardVersion: "0.0.0",
    }),
    createSQLiteBootstrapDescriptor({
      dataRoot,
      workerEntry: databaseWorkerEntry,
      readWorkers: 1,
    }),
  ];
  const manifest: PluginManifest = {
    id: "example.entry-location",
    version: "1.0.0",
    publisher: "example",
    entries: [
      {
        id: "controller",
        runtime: "host",
        execution: "controller",
        module: "./dist/controller.js",
        hostProfiles: ["node"],
        activationScopes: ["global"],
        permissions: [],
      },
      {
        id: "worker",
        runtime: "host",
        execution: "host",
        module: "./dist/worker.js",
        hostProfiles: ["node"],
        activationScopes: ["global"],
        permissions: [],
      },
    ],
    compatibility: { seaShard: ">=0.0.0 <1.0.0" },
  };
  const registration = {
    manifest,
    loaders: {
      controller: { load: async () => ({ apply() {} }) },
      worker: { load: async () => ({ apply() {} }) },
    },
    bindings: [
      {
        id: "core.entry-location.controller",
        entryId: "controller",
        scopeType: "global" as const,
        scopeId: "global",
        enabled: true,
        config: null,
      },
      {
        id: "core.entry-location.worker",
        entryId: "worker",
        scopeType: "global" as const,
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  };

  try {
    await controllerLoader.start(descriptor(controllerDirectory));
    await hostLoader.start(descriptor(hostDirectory));
    controller = await PluginKernel.create({
      dataRoot: controllerDirectory,
      seaShardVersion: "0.0.0",
      pluginHostEntry: "unused-plugin-host.js",
      hostProfile: "node",
      executionLocation: "controller",
      platform: "win32",
      architecture: "x64",
      root: controllerRoot,
      store: controllerRoot["plugin-foundation"].store,
      pluginStorage: controllerRoot["plugin-foundation"].storage,
    });
    host = await PluginKernel.create({
      dataRoot: hostDirectory,
      seaShardVersion: "0.0.0",
      pluginHostEntry: "unused-plugin-host.js",
      hostProfile: "node",
      executionLocation: "host",
      platform: "win32",
      architecture: "x64",
      root: hostRoot,
      store: hostRoot["plugin-foundation"].store,
      pluginStorage: hostRoot["plugin-foundation"].storage,
      agentExtensions: false,
    });
    await controller.registerBuiltIn(registration);
    await host.registerBuiltIn(registration);
    await controller.start();
    await host.start();

    assert.deepEqual(
      controller.runtimeSnapshot().plugins.map(({ runtimeId }) => runtimeId),
      ["core.entry-location.controller"],
    );
    assert.deepEqual(
      host.runtimeSnapshot().plugins.map(({ runtimeId }) => runtimeId),
      ["core.entry-location.worker"],
    );
  } finally {
    await host?.dispose();
    await controller?.dispose();
    await hostLoader.dispose();
    await controllerLoader.dispose();
    await rm(hostDirectory, { recursive: true, force: true });
    await rm(controllerDirectory, { recursive: true, force: true });
  }
});

await test("Host Worker deployment verifies package digest and reconciles exact Worker bindings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-host-worker-"));
  const sourceRoot = join(directory, "source");
  const hostRoot = join(directory, "host");
  const root = new Context();
  const loader = new BootstrapLoader(root);
  let kernel: PluginKernel | undefined;
  try {
    await mkdir(join(sourceRoot, "dist"), { recursive: true });
    await writeFile(
      join(sourceRoot, "plugin.json"),
      `${JSON.stringify(
        {
          id: "example.host-worker",
          version: "1.0.0",
          publisher: "example",
          entries: [
            {
              id: "worker",
              runtime: "host",
              execution: "host",
              module: "./dist/worker.js",
              hostProfiles: ["node"],
              uses: {},
            },
          ],
          compatibility: { seaShard: ">=0.0.0 <1.0.0" },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(sourceRoot, "dist", "worker.js"), "export function apply() {}\n");
    await loader.start([
      createPluginFoundationBootstrapDescriptor({
        dataRoot: hostRoot,
        workerEntry: databaseWorkerEntry,
        seaShardVersion: "0.0.0",
      }),
      createSQLiteBootstrapDescriptor({
        dataRoot: hostRoot,
        workerEntry: databaseWorkerEntry,
        readWorkers: 1,
      }),
    ]);
    kernel = await PluginKernel.create({
      dataRoot: hostRoot,
      seaShardVersion: "0.0.0",
      pluginHostEntry: "unused-plugin-host.js",
      hostProfile: "node",
      executionLocation: "host",
      platform: "win32",
      architecture: "x64",
      root,
      store: root["plugin-foundation"].store,
      pluginStorage: root["plugin-foundation"].storage,
      agentExtensions: false,
    });
    await kernel.start();
    const candidate = await kernel.installer.inspectDevelopmentDirectory(sourceRoot);

    await kernel.deployHostWorkerPackage({
      pluginId: candidate.manifest.id,
      digest: candidate.digest,
      source: "installed",
      sourceRoot,
      entries: [{ entryId: "worker", enabled: false, config: {} }],
    });

    assert.deepEqual(await kernel.listHostWorkerPluginIds(), ["example.host-worker"]);
    assert.deepEqual(await root["plugin-foundation"].store.listBindings("example.host-worker"), [
      {
        id: "plugin:example.host-worker:worker",
        pluginId: "example.host-worker",
        entryId: "worker",
        scopeType: "global",
        scopeId: "global",
        enabled: false,
        config: {},
      },
    ]);
    await assert.rejects(
      kernel.deployHostWorkerPackage({
        pluginId: candidate.manifest.id,
        digest: "0".repeat(64),
        source: "installed",
        sourceRoot,
        entries: [{ entryId: "worker", enabled: false, config: {} }],
      }),
      /digest changed/,
    );

    await kernel.removeHostWorkerPackage("example.host-worker");
    assert.deepEqual(await kernel.listHostWorkerPluginIds(), []);
  } finally {
    await kernel?.dispose();
    await loader.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("package installation enables every Entry without activating incompatible Hosts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-install-enable-"));
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
      clientTarget: "desktop",
      platform: "win32",
      architecture: "x64",
      root,
      store: root["plugin-foundation"].store,
      pluginStorage: root["plugin-foundation"].storage,
    });
    const manifest: PluginManifest = {
      id: "example.install-auto-enable",
      version: "1.0.0",
      publisher: "example",
      entries: [
        {
          id: "client",
          runtime: "client",
          module: "./dist/client.js",
          targets: ["desktop"],
          uses: { "example.client-bridge": ["echo"] },
          activationScopes: ["global"],
          permissions: ["example.client-bridge"],
        },
        {
          id: "electron-only",
          runtime: "host",
          module: "./dist/electron-only.js",
          hostProfiles: ["electron"],
          uses: {},
          activationScopes: ["global"],
          permissions: [],
        },
      ],
      compatibility: { seaShard: ">=0.0.0 <1.0.0" },
    };
    const record: PluginPackageRecord = {
      manifest,
      digest: "d".repeat(64),
      rootPath: "C:/plugins/example.install-auto-enable",
      source: "installed" as const,
      trust: "package-full-trust" as const,
      installedAt: "2026-08-25T00:00:00.000Z",
    };
    await root["plugin-foundation"].store.registerPackage(record);

    await kernel.selectPackageVersionAndEnable(record);

    assert.deepEqual(await root["plugin-foundation"].store.listBindings(manifest.id), [
      {
        id: "plugin:example.install-auto-enable:client",
        pluginId: manifest.id,
        entryId: "client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: {},
      },
      {
        id: "plugin:example.install-auto-enable:electron-only",
        pluginId: manifest.id,
        entryId: "electron-only",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: {},
      },
    ]);
    assert.deepEqual(
      kernel
        .clientEntrySnapshot()
        .entries.map((entry) => [entry.runtimeId, entry.package.manifest.id]),
      [["plugin:example.install-auto-enable:client", manifest.id]],
    );
    kernel.services.register(
      "example.client-bridge",
      "plugin:example.install-auto-enable:host",
      { type: "global", id: "global" },
      {
        echo: async (value) => ({ echoed: value }),
      },
    );
    const clientRuntimeId = "plugin:example.install-auto-enable:client";
    assert.deepEqual(
      await kernel.callClientService({
        runtimeId: clientRuntimeId,
        integrity: record.digest,
        contract: "example.client-bridge",
        method: "echo",
        args: ["hello"],
      }),
      { echoed: "hello" },
    );
    await assert.rejects(
      kernel.callClientService({
        runtimeId: clientRuntimeId,
        integrity: record.digest,
        contract: "example.client-bridge",
        method: "remove",
        args: [],
      }),
      /did not declare example\.client-bridge\.remove/u,
    );
    await assert.rejects(
      kernel.callClientService({
        runtimeId: clientRuntimeId,
        integrity: "e".repeat(64),
        contract: "example.client-bridge",
        method: "echo",
        args: [],
      }),
      /client runtime is not active/u,
    );
    const listed = await kernel.listThirdPartyPlugins();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, manifest.id);
    assert.equal(listed[0]?.source, "installed");
    assert.equal(listed[0]?.enabled, true);
    assert.deepEqual(
      listed[0]?.entries.map((entry) => [entry.id, entry.enabled, entry.state]),
      [
        ["client", true, "active"],
        ["electron-only", true, "inactive"],
      ],
    );

    const disabled = await kernel.setThirdPartyPluginEnabled(manifest.id, false);
    assert.equal(disabled.enabled, false);
    assert.deepEqual(kernel.clientEntrySnapshot().entries, []);
    assert.deepEqual(
      (await root["plugin-foundation"].store.listBindings(manifest.id)).map(({ id, enabled }) => [
        id,
        enabled,
      ]),
      [
        ["plugin:example.install-auto-enable:client", false],
        ["plugin:example.install-auto-enable:electron-only", false],
      ],
    );

    const enabled = await kernel.setThirdPartyPluginEnabled(manifest.id, true);
    assert.equal(enabled.enabled, true);
    assert.deepEqual(
      kernel.clientEntrySnapshot().entries.map(({ runtimeId }) => runtimeId),
      ["plugin:example.install-auto-enable:client"],
    );
  } finally {
    await kernel?.dispose();
    await loader.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("uninstall removes every installed version after runtimes converge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-uninstall-"));
  const sourceRoot = join(directory, "source");
  const root = new Context();
  const loader = new BootstrapLoader(root);
  let kernel: PluginKernel | undefined;
  try {
    await mkdir(join(sourceRoot, "dist"), { recursive: true });
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
      clientTarget: "desktop",
      platform: "win32",
      architecture: "x64",
      root,
      store: root["plugin-foundation"].store,
      pluginStorage: root["plugin-foundation"].storage,
    });

    const pluginId = "example.uninstall";
    const manifest = (version: string): PluginPackageManifest => ({
      id: pluginId,
      version,
      publisher: "example",
      entries: [
        {
          id: "client",
          runtime: "client",
          module: "./dist/client.js",
          targets: ["desktop"],
          uses: {},
        },
      ],
      compatibility: { seaShard: ">=0.0.0 <1.0.0" },
    });
    const install = async (version: string): Promise<PluginPackageRecord> => {
      await writeFile(
        join(sourceRoot, "plugin.json"),
        `${JSON.stringify(manifest(version), null, 2)}\n`,
      );
      await writeFile(
        join(sourceRoot, "dist", "client.js"),
        `export const version = "${version}";\n`,
      );
      const prepared = await kernel!.prepareDirectory(sourceRoot);
      try {
        const record = await prepared.commit({
          digest: prepared.digest,
          acknowledgeFullMachineAccess: true,
        });
        await kernel!.selectPackageVersionAndEnable(record);
        return record;
      } finally {
        await prepared.dispose();
      }
    };

    const first = await install("1.0.0");
    const second = await install("2.0.0");
    assert.equal((await root["plugin-foundation"].store.listPackages(pluginId)).length, 2);
    assert.equal(kernel.clientEntrySnapshot().entries[0]?.package.digest, second.digest);

    await kernel.uninstallThirdPartyPlugin(pluginId);

    assert.deepEqual(await kernel.listThirdPartyPlugins(), []);
    assert.deepEqual(await root["plugin-foundation"].store.listPackages(pluginId), []);
    assert.deepEqual(await root["plugin-foundation"].store.listBindings(pluginId), []);
    assert.deepEqual(kernel.clientEntrySnapshot().entries, []);
    await assert.rejects(stat(first.rootPath), { code: "ENOENT" });
    await assert.rejects(stat(second.rootPath), { code: "ENOENT" });
  } finally {
    await kernel?.dispose();
    await loader.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("development plugin toggle survives command-line directory refresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-development-toggle-"));
  const sourceRoot = join(directory, "plugin");
  const root = new Context();
  const loader = new BootstrapLoader(root);
  let kernel: PluginKernel | undefined;
  try {
    await mkdir(join(sourceRoot, "dist"), { recursive: true });
    const manifest: PluginPackageManifest = {
      id: "example.development-toggle",
      version: "1.0.0",
      publisher: "example",
      entries: [
        {
          id: "client",
          runtime: "client",
          module: "./dist/client.js",
          targets: ["desktop"],
          uses: {},
        },
      ],
      compatibility: {
        seaShard: ">=0.0.0 <1.0.0",
        clientProtocol: ">=1 <2",
      },
    };
    await writeFile(join(sourceRoot, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(sourceRoot, "dist", "client.js"), "export const apply = () => {};\n");
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
      clientTarget: "desktop",
      platform: "win32",
      architecture: "x64",
      root,
      store: root["plugin-foundation"].store,
      pluginStorage: root["plugin-foundation"].storage,
    });

    const first = await kernel.refreshDevelopmentDirectory(sourceRoot);
    assert.equal((await kernel.listThirdPartyPlugins())[0]?.source, "development");
    assert.equal(kernel.clientEntrySnapshot().entries.length, 1);

    const disabled = await kernel.setThirdPartyPluginEnabled(manifest.id, false);
    assert.equal(disabled.enabled, false);
    assert.deepEqual(kernel.clientEntrySnapshot().entries, []);

    await writeFile(
      join(sourceRoot, "dist", "client.js"),
      "export const apply = () => {}; export const revision = 2;\n",
    );
    const refreshed = await kernel.refreshDevelopmentDirectory(sourceRoot, first.manifest.id);
    assert.notEqual(refreshed.digest, first.digest);
    assert.equal((await kernel.listThirdPartyPlugins())[0]?.enabled, false);
    assert.deepEqual(kernel.clientEntrySnapshot().entries, []);

    const enabled = await kernel.setThirdPartyPluginEnabled(manifest.id, true);
    assert.equal(enabled.enabled, true);
    assert.deepEqual(
      kernel.clientEntrySnapshot().entries.map(({ runtimeId }) => runtimeId),
      ["dev:example.development-toggle:client"],
    );
  } finally {
    await kernel?.dispose();
    await loader.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
