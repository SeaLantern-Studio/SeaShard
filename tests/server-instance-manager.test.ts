import {
  serverCoreIconHost,
  serverCoreIconScheme,
  type ServerCoreArtifact,
  type ServerCoreDownloadTaskSnapshot,
  type ServerCoreType,
} from "../packages/contracts/src/index.ts";
import { SQLiteDatabaseBroker } from "../components/data/database-sqlite/src/index.ts";
import { defineDataCapsule } from "../packages/database/src/index.ts";
import type {
  ServerCoreSourceService,
  StartServerCoreDownloadRequest,
} from "../components/server/core-source/src/index.ts";
import {
  ServerInstanceManager,
  SQLiteServerInstanceRegistry,
  portableInstanceMetadataDirectoryName,
  portableSeaShardInstanceFileName,
  portableServerInformationFileName,
  serverInstanceDataCapsule,
  writePortableInstanceManifests,
  type PortableSeaShardInstanceManifest,
  type PortableServerInformationManifest,
} from "../components/server/instance-manager/src/index.ts";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const databaseWorkerEntry = new URL("../apps/database-worker/dist/index.js", import.meta.url);
const artifactHash = "a".repeat(64);
const iconHash = "b".repeat(64);
const iconBytes = Buffer.from("server-core-icon");

/**
 * 预发布阶段曾把完整实例实体写进旧命名空间；其迁移摘要可能已落盘。
 * 当前路径索引必须与这份退役 Capsule 隔离，否则 Runtime 会在启动时因摘要变化而失败。
 */
const retiredServerInstanceDataCapsule = defineDataCapsule({
  namespace: "server_instance_manager",
  schemaVersion: 1,
  compatibilityFloor: 1,
  tables: ["server_instances"],
  migrations: [
    {
      version: 1,
      statements: [
        `CREATE TABLE server_instances (
          id TEXT PRIMARY KEY NOT NULL,
          root_path TEXT NOT NULL
        ) STRICT`,
      ],
      verify: [
        {
          sql: `SELECT COUNT(*) = 1 AS valid
                  FROM sqlite_schema
                 WHERE type = 'table' AND name = 'server_instances'`,
          column: "valid",
          equals: 1,
        },
      ],
    },
  ],
  commands: [
    {
      id: "legacy.list",
      access: "read",
      result: "all",
      sql: "SELECT id, root_path FROM server_instances ORDER BY id",
    },
  ],
});

class FakeServerCoreSource implements ServerCoreSourceService {
  private taskNumber = 0;
  private readonly tasks = new Map<string, ServerCoreDownloadTaskSnapshot>();

  constructor(
    private readonly terminalState: "completed" | "failed" = "completed",
    private readonly iconPath?: string,
  ) {}

  async listTypes(): Promise<readonly ServerCoreType[]> {
    return this.iconPath
      ? [
          {
            id: request.serverType,
            iconUrl: `${serverCoreIconScheme}://${serverCoreIconHost}/${iconHash}`,
          },
        ]
      : [];
  }

  async resolveIconPath(sha256: string): Promise<string | null> {
    return sha256 === iconHash ? (this.iconPath ?? null) : null;
  }

  async listVersions(): Promise<readonly string[]> {
    return [];
  }

  async listArtifacts(): Promise<readonly ServerCoreArtifact[]> {
    return [];
  }

  async start(request: StartServerCoreDownloadRequest): Promise<ServerCoreDownloadTaskSnapshot> {
    const id = `task-${++this.taskNumber}`;
    const destinationPath = join(request.destinationDirectory, request.destinationFileName);
    await writeFile(destinationPath, `core-${id}\n`, "utf8");
    const task: ServerCoreDownloadTaskSnapshot = {
      id,
      artifact: {
        source: "cnb",
        serverType: request.serverType,
        gameVersion: request.gameVersion,
        fileName: request.artifactFileName,
        url: `https://example.invalid/${request.artifactFileName}`,
        sha256: artifactHash,
      },
      destinationPath,
      state: "queued",
      downloadedBytes: 0,
      totalBytes: 0,
      connections: request.connections,
      progress: 0,
      createdAt: "2026-08-17T00:00:00.000Z",
    };
    this.tasks.set(id, task);
    return task;
  }

  async snapshot(taskId: string): Promise<ServerCoreDownloadTaskSnapshot | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async wait(taskId: string): Promise<ServerCoreDownloadTaskSnapshot | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const completed: ServerCoreDownloadTaskSnapshot = {
      ...task,
      state: this.terminalState,
      downloadedBytes: this.terminalState === "completed" ? 12 : 0,
      totalBytes: 12,
      progress: this.terminalState === "completed" ? 1 : 0,
      finishedAt: "2026-08-17T00:00:01.000Z",
      ...(this.terminalState === "failed" ? { error: "fixture download failed" } : {}),
    };
    this.tasks.set(taskId, completed);
    return completed;
  }

  async listTasks(): Promise<readonly ServerCoreDownloadTaskSnapshot[]> {
    return [...this.tasks.values()];
  }

  async cancel(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || ["completed", "failed", "cancelled"].includes(task.state)) return false;
    this.tasks.set(taskId, {
      ...task,
      state: "cancelled",
      finishedAt: "2026-08-17T00:00:01.000Z",
      error: "download cancelled",
    });
    return true;
  }
}

const request = {
  serverType: "arclight fabric",
  gameVersion: "1.21.1",
  artifactFileName: "arclight-fabric-1.21.1.jar",
  destinationFileName: "server.jar",
  connections: 8,
} as const;

await test("managed downloads persist unique instances and split portable manifests", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-instance-manager-"));
  const databasePath = join(dataRoot, "seashard.sqlite3");
  const managedRoot = join(dataRoot, "servers");
  const coreIconPath = join(dataRoot, "core-icon.png");
  await writeFile(coreIconPath, iconBytes);
  let broker = await SQLiteDatabaseBroker.create({
    databasePath,
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });
  try {
    let repository = await broker.registerCapsule(serverInstanceDataCapsule);
    let registry = new SQLiteServerInstanceRegistry(repository);
    let idNumber = 0;
    const manager = new ServerInstanceManager({
      managedRoot,
      registry,
      coreSource: new FakeServerCoreSource("completed", coreIconPath),
      createId: () => `instance-${++idNumber}`,
      now: () => "2026-08-17T00:00:00.000Z",
    });

    const [firstResult, secondResult] = await Promise.all([
      manager.createManaged(request),
      manager.createManaged(request),
    ]);
    await Promise.all([
      manager.waitForManagedTask(firstResult.task.id),
      manager.waitForManagedTask(secondResult.task.id),
    ]);
    assert.deepEqual(
      new Set([firstResult.instanceId, secondResult.instanceId]),
      new Set(["instance-1", "instance-2"]),
    );

    const instances = await manager.list();
    assert.deepEqual(
      new Set(instances.map(({ name }) => name)),
      new Set(["1.21.1-arclight_fabric", "1.21.1-arclight_fabric(1)"]),
    );
    assert.equal(
      instances.every(({ storageMode }) => storageMode === "managed"),
      true,
    );
    assert.equal(
      instances.every(({ source }) => source === "downloaded"),
      true,
    );
    const coreContents = new Set<string>();

    for (const instance of instances) {
      coreContents.add(await readFile(instance.coreJarPath, "utf8"));
      const metadataDirectory = join(instance.rootPath, portableInstanceMetadataDirectoryName);
      assert.equal(instance.iconPath, join(metadataDirectory, "icon.png"));
      assert.deepEqual(await readFile(instance.iconPath!), iconBytes);
      assert.equal(await manager.resolveIconPath(instance.id), instance.iconPath);

      const seaShardManifestPath = join(metadataDirectory, portableSeaShardInstanceFileName);
      const serverInformationPath = join(metadataDirectory, portableServerInformationFileName);
      const seaShardManifest = JSON.parse(
        await readFile(seaShardManifestPath, "utf8"),
      ) as PortableSeaShardInstanceManifest;
      const serverInformation = JSON.parse(
        await readFile(serverInformationPath, "utf8"),
      ) as PortableServerInformationManifest;
      assert.equal(seaShardManifest.schemaVersion, 1);
      assert.equal(seaShardManifest.id, instance.id);
      assert.equal(seaShardManifest.name, instance.name);
      assert.equal(seaShardManifest.icon, "icon.png");
      assert.equal("gameVersion" in seaShardManifest, false);
      assert.equal(serverInformation.schemaVersion, 1);
      assert.equal(serverInformation.core.path, "server.jar");
      assert.equal(serverInformation.core.type, request.serverType);
      assert.equal(serverInformation.core.artifact?.fileName, request.artifactFileName);
      assert.equal(serverInformation.core.artifact?.sha256, artifactHash);
      assert.equal(serverInformation.minecraft.version, request.gameVersion);
      assert.equal("name" in serverInformation, false);
    }
    assert.deepEqual(coreContents, new Set(["core-task-1\n", "core-task-2\n"]));
    assert.deepEqual(
      new Set(await registry.listManifestPaths()),
      new Set(
        instances.map(({ rootPath }) =>
          join(rootPath, portableInstanceMetadataDirectoryName, portableSeaShardInstanceFileName),
        ),
      ),
    );

    await manager.dispose();
    await broker.close();
    broker = await SQLiteDatabaseBroker.create({
      databasePath,
      workerEntry: databaseWorkerEntry,
      readWorkers: 1,
    });
    repository = await broker.registerCapsule(serverInstanceDataCapsule);
    registry = new SQLiteServerInstanceRegistry(repository);
    const reloadedManager = new ServerInstanceManager({
      managedRoot,
      registry,
      coreSource: new FakeServerCoreSource("completed", coreIconPath),
    });
    assert.deepEqual(
      await reloadedManager.list(),
      instances,
      "split portable JSON must remain the restart source of truth",
    );
    await reloadedManager.dispose();
  } finally {
    await broker.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("split portable JSON remains authoritative after path registration", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-instance-json-authority-"));
  const broker = await SQLiteDatabaseBroker.create({
    databasePath: join(dataRoot, "seashard.sqlite3"),
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });
  try {
    const repository = await broker.registerCapsule(serverInstanceDataCapsule);
    const registry = new SQLiteServerInstanceRegistry(repository);
    const rootPath = join(dataRoot, "servers", "json-authority");
    const coreJarPath = join(rootPath, "server.jar");
    await mkdir(rootPath, { recursive: true });
    await writeFile(coreJarPath, "json-authority-core\n", "utf8");
    const instance = {
      id: "json-authority",
      name: "original-name",
      rootPath,
      coreJarPath,
      storageMode: "managed",
      source: "downloaded",
      serverType: "paper",
      gameVersion: "1.21.1",
      coreArtifactFileName: "paper-1.21.1-131.jar",
      artifactSha256: artifactHash,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      lastStartedAt: "2026-08-16T01:00:00.000Z",
    } as const;
    const manifestPath = await writePortableInstanceManifests(instance);
    await registry.insertManifestPath(manifestPath);
    const manager = new ServerInstanceManager({
      managedRoot: join(dataRoot, "servers"),
      registry,
      coreSource: new FakeServerCoreSource(),
    });

    const seaShardManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as PortableSeaShardInstanceManifest;
    seaShardManifest.name = "json-authoritative-name";
    seaShardManifest.updatedAt = "2026-08-17T00:00:00.000Z";
    await writeFile(manifestPath, `${JSON.stringify(seaShardManifest, null, 2)}\n`, "utf8");
    const serverInformationPath = join(dirname(manifestPath), portableServerInformationFileName);
    const serverInformation = JSON.parse(
      await readFile(serverInformationPath, "utf8"),
    ) as PortableServerInformationManifest;
    serverInformation.minecraft.version = "1.21.2";
    await writeFile(
      serverInformationPath,
      `${JSON.stringify(serverInformation, null, 2)}\n`,
      "utf8",
    );

    const [reloaded] = await manager.list();
    assert.equal(reloaded?.name, "json-authoritative-name");
    assert.equal(reloaded?.gameVersion, "1.21.2");
    assert.equal(reloaded?.coreArtifactFileName, "paper-1.21.1-131.jar");
    assert.equal(reloaded?.updatedAt, "2026-08-17T00:00:00.000Z");
    assert.equal(reloaded?.lastStartedAt, "2026-08-16T01:00:00.000Z");
    assert.deepEqual(await registry.listManifestPaths(), [manifestPath]);
    await manager.dispose();
  } finally {
    await broker.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("path registry activates beside a retired pre-release entity schema", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-instance-index-cutover-"));
  const broker = await SQLiteDatabaseBroker.create({
    databasePath: join(dataRoot, "seashard.sqlite3"),
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });
  try {
    await broker.registerCapsule(retiredServerInstanceDataCapsule);

    const repository = await broker.registerCapsule(serverInstanceDataCapsule);
    const registry = new SQLiteServerInstanceRegistry(repository);
    assert.deepEqual(await registry.listManifestPaths(), []);
  } finally {
    await broker.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("existing managed instances inherit their server type icon on first read", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-instance-icon-backfill-"));

  const broker = await SQLiteDatabaseBroker.create({
    databasePath: join(dataRoot, "seashard.sqlite3"),
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });
  try {
    const repository = await broker.registerCapsule(serverInstanceDataCapsule);
    const registry = new SQLiteServerInstanceRegistry(repository);
    const rootPath = join(dataRoot, "servers", "legacy-instance");
    const coreJarPath = join(rootPath, "server.jar");
    const coreIconPath = join(dataRoot, "core-icon.png");
    await mkdir(rootPath, { recursive: true });
    await writeFile(coreJarPath, "legacy-core\n", "utf8");
    await writeFile(coreIconPath, iconBytes);
    const legacyInstance = {
      id: "legacy-instance",
      name: "1.21.1-arclight_fabric",
      rootPath,
      coreJarPath,
      storageMode: "managed",
      source: "downloaded",
      serverType: request.serverType,
      gameVersion: request.gameVersion,
      artifactSha256: artifactHash,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    } as const;
    const manifestPath = await writePortableInstanceManifests(legacyInstance);
    await registry.insertManifestPath(manifestPath);
    const manager = new ServerInstanceManager({
      managedRoot: join(dataRoot, "servers"),
      registry,
      coreSource: new FakeServerCoreSource("completed", coreIconPath),
      now: () => "2026-08-17T00:00:00.000Z",
    });

    const [instance] = await manager.list();
    const metadataDirectory = join(rootPath, portableInstanceMetadataDirectoryName);
    assert.equal(instance?.iconPath, join(metadataDirectory, "icon.png"));
    assert.deepEqual(await readFile(instance!.iconPath!), iconBytes);
    const manifest = JSON.parse(
      await readFile(join(metadataDirectory, portableSeaShardInstanceFileName), "utf8"),
    ) as PortableSeaShardInstanceManifest;
    assert.equal(manifest.icon, "icon.png");
    await manager.dispose();
  } finally {
    await broker.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("failed managed downloads leave neither a registry row nor an instance directory", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-instance-manager-failed-"));
  const broker = await SQLiteDatabaseBroker.create({
    databasePath: join(dataRoot, "seashard.sqlite3"),
    workerEntry: databaseWorkerEntry,
    readWorkers: 1,
  });
  try {
    const repository = await broker.registerCapsule(serverInstanceDataCapsule);
    const registry = new SQLiteServerInstanceRegistry(repository);
    const managedRoot = join(dataRoot, "servers");
    const manager = new ServerInstanceManager({
      managedRoot,
      registry,
      coreSource: new FakeServerCoreSource("failed"),
      createId: () => "failed-instance",
    });

    const result = await manager.createManaged(request);
    await manager.waitForManagedTask(result.task.id);
    assert.deepEqual(await registry.listManifestPaths(), []);
    await assert.rejects(access(join(managedRoot, "failed-instance")), { code: "ENOENT" });
    await manager.dispose();
  } finally {
    await broker.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
