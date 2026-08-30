import {
  serverCoreIconHost,
  serverCoreIconScheme,
  type ServerCoreArtifact,
  type ServerCoreDownloadTaskSnapshot,
  type ServerInstanceStartupSettings,
  type ServerCoreType,
} from "../packages/contracts/src/index.ts";
import { strToU8, zipSync } from "fflate";
import { SQLiteDatabaseBroker } from "../components/data/database-sqlite/src/index.ts";
import { defineDataCapsule } from "../packages/database/src/index.ts";
import type {
  ServerCoreSourceService,
  StartServerCoreDownloadRequest,
} from "../components/server/core-source/src/index.ts";
import {
  ServerInstanceManager,
  ServerInstanceRuntimeGate,
  SQLiteServerInstanceRegistry,
  registerServerInstanceAgentResources,
  projectServerInstanceForClient,
  createShortRandomId,
  portableInstanceMetadataDirectoryName,
  portableSeaShardInstanceFileName,
  portableServerInformationFileName,
  serverInstanceDataCapsule,
  parseResourceSourceIndex,
  removeResourceSources,
  writePortableInstanceManifests,
  type PortableSeaShardInstanceManifest,
  type PortableServerInformationManifest,
} from "../components/server/instance-manager/src/index.ts";
import { AgentResourceRegistry } from "../packages/plugin-system/src/runtime-registries.ts";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

const databaseWorkerEntry = new URL("../apps/database-worker/dist/index.js", import.meta.url);
const artifactHash = "a".repeat(64);
const iconHash = "b".repeat(64);
await test("server instance client projection preserves custom icon URLs without host paths", () => {
  const projection = projectServerInstanceForClient({
    id: "instance-paper",
    name: "Paper",
    rootPath: "C:/SeaShard/servers/instance-paper",
    coreJarPath: "C:/SeaShard/servers/instance-paper/server.jar",
    iconPath: "C:/SeaShard/servers/instance-paper/.seashard/icon.png",
    storageMode: "managed",
    source: "downloaded",
    modLoader: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    resourceSources: {},
  });

  assert.equal(projection.iconUrl, `${serverCoreIconScheme}://server-instance-icon/instance-paper`);
  assert.equal("iconPath" in projection, false);
  assert.equal("resourceSources" in projection, false);
});

await test("server instance component owns pagination, projection and card presentation", async () => {
  const registry = new AgentResourceRegistry();
  registerServerInstanceAgentResources(
    {
      agentResources(resources) {
        for (const [pattern, resource] of Object.entries(resources)) {
          registry.register(
            "test.server-instance-manager",
            { type: "global", id: "global" },
            pattern,
            resource,
          );
        }
      },
    },
    {
      listInstances: async () => [
        {
          id: "server-1",
          name: "Fabric",
          rootPath: "C:/SeaShard/servers/server-1",
          coreJarPath: "C:/SeaShard/servers/server-1/fabric.jar",
          iconPath: "C:/SeaShard/servers/server-1/.seashard/icon.png",
          storageMode: "managed",
          source: "downloaded",
          modLoader: "fabric",
          serverType: "fabric",
          gameVersion: "1.21.1",
          createdAt: "2026-08-21T00:00:00.000Z",
          updatedAt: "2026-08-21T01:00:00.000Z",
          lastStartedAt: "2026-08-21T00:30:00.000Z",
        },
      ],
    },
  );
  const snapshot = registry.snapshot();
  assert.equal(snapshot.definitions.length, 1);
  assert.equal(snapshot.definitions[0]?.pattern, "server://instances");
  assert.equal(snapshot.definitions[0]?.presentation?.title, "读取服务器实例");
  assert.deepEqual(snapshot.definitions[0]?.inputSchema.required, undefined);
  const prepared = snapshot.prepare("server://instances", {
    page: 1,
    pageSize: 10,
    modLoader: "fabric",
  });
  assert.deepEqual(await prepared.presentRequest(), [
    { value: "1～10" },
    { label: "类型", value: "Fabric" },
  ]);
  const result = await prepared.read();
  assert.equal(result.mimeType, "application/json");
  assert.deepEqual(result.content, {
    items: [
      {
        id: "server-1",
        name: "Fabric",
        storageMode: "managed",
        source: "downloaded",
        modLoader: "fabric",
        serverType: "fabric",
        gameVersion: "1.21.1",
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T01:00:00.000Z",
        lastStartedAt: "2026-08-21T00:30:00.000Z",
      },
    ],
    pagination: {
      page: 1,
      pageSize: 10,
      totalItems: 1,
      totalPages: 1,
      hasMore: false,
    },
  });
  assert.deepEqual(await prepared.presentResult(result), [{ value: "1", unit: "个结果" }]);
  assert.doesNotMatch(
    JSON.stringify(result.content),
    /rootPath|coreJarPath|iconPath|SeaShard\/servers/u,
  );
  assert.throws(
    () => snapshot.prepare("server://instances", { page: 1, pageSize: 101 }),
    /不符合 inputSchema/,
  );
});

await test("resource source index keeps valid unknown origins and ignores malformed records", () => {
  const valid = {
    source: "modrinth",
    id: "server-mod-1",
    version: "1.2.3",
    iconUrl: "https://cdn.modrinth.com/data/server-mod-1/icon.webp",
  };
  const custom = {
    source: "github",
    id: "owner-repo",
    iconUrl: "https://github.com/owner/repo/icon.png",
  };
  assert.deepEqual(
    parseResourceSourceIndex({
      mods: {
        "mods/server-tools.jar": valid,
        "mods/custom-source.jar": custom,
        "../outside.jar": valid,
        "mods/invalid-source.jar": { ...valid, source: "unknown source" },
        "mods/untrusted-icon.jar": {
          source: "modrinth",
          id: "server-mod-2",
          iconUrl: "https://example.invalid/icon.webp",
        },
      },
    }),
    {
      mods: {
        "mods/server-tools.jar": valid,
        "mods/custom-source.jar": custom,
        "mods/untrusted-icon.jar": {
          source: "modrinth",
          id: "server-mod-2",
        },
      },
    },
  );
  assert.equal(
    parseResourceSourceIndex({
      mods: { "../outside.jar": valid },
    }),
    undefined,
  );
});
await test("resource source index removes datapack paths after deletion", () => {
  const metadata = { source: "modrinth", id: "pack-1" };
  const remaining = removeResourceSources(
    {
      datapacks: {
        "survival/datapacks/pack.zip": metadata,
        "survival/datapacks/other.zip": metadata,
      },
      worlds: {
        "worlds/world": { source: "curseforge", id: "world-1" },
      },
    },
    "datapack",
    ["survival/datapacks/pack.zip"],
  );
  assert.deepEqual(remaining, {
    datapacks: {
      "survival/datapacks/other.zip": metadata,
    },
    worlds: {
      "worlds/world": { source: "curseforge", id: "world-1" },
    },
  });
});
const iconBytes = Buffer.from("server-core-icon");

await test("short directory IDs use six lowercase alphanumeric characters", () => {
  for (let index = 0; index < 32; index += 1) {
    assert.match(createShortRandomId(), /^[a-z0-9]{6}$/u);
  }
});

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
  serverType: "arclight-fabric",
  gameVersion: "1.21.1",
  artifactFileName: "arclight-fabric-1.21.1.jar",
  destinationFileName: "server.jar",
  connections: 8,
} as const;

const instanceStartupSettings = {
  minimumMemoryMiB: 1_536,
  maximumMemoryMiB: 4_096,
  serverPort: 25_570,
  autoAcceptEula: false,
  jvmArguments: "-XX:+UseG1GC",
} satisfies ServerInstanceStartupSettings;

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
    const runtimeGate = new ServerInstanceRuntimeGate();
    const manager = new ServerInstanceManager({
      managedRoot,
      registry,
      coreSource: new FakeServerCoreSource("completed", coreIconPath),
      runtimeGate,
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
      new Set(["1.21.1-arclight-fabric", "1.21.1-arclight-fabric(1)"]),
    );
    assert.equal(
      instances.every(({ storageMode }) => storageMode === "managed"),
      true,
    );
    assert.equal(
      instances.every(({ source }) => source === "downloaded"),
      true,
    );
    assert.equal(
      instances.every(({ modLoader }) => modLoader === "fabric"),
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
      assert.equal(seaShardManifest.worldStorageDirectoryName, undefined);
      assert.equal(seaShardManifest.backupDirectoryName, undefined);
      assert.equal(instance.worldStorageDirectoryName, undefined);
      assert.equal(instance.backupDirectoryName, undefined);
      assert.equal("gameVersion" in seaShardManifest, false);
      assert.equal(serverInformation.schemaVersion, 1);
      assert.equal(serverInformation.modLoader, "fabric");
      assert.equal(serverInformation.core.path, "server.jar");
      assert.equal(serverInformation.core.type, request.serverType);
      assert.equal(serverInformation.core.artifact?.fileName, request.artifactFileName);
      assert.equal(serverInformation.core.artifact?.sha256, artifactHash);
      assert.equal(serverInformation.minecraft.version, request.gameVersion);
      assert.equal("name" in serverInformation, false);
    }
    const renamed = await manager.rename("instance-1", " Survival ");
    assert.equal(renamed.name, "Survival");
    await assert.rejects(
      manager.rename("instance-2", "ｓｕｒｖｉｖａｌ"),
      /服务器实例名称已被占用/u,
    );
    assert.equal((await manager.list()).find(({ id }) => id === "instance-1")?.name, "Survival");
    const renamedManifest = JSON.parse(
      await readFile(
        join(
          renamed.rootPath,
          portableInstanceMetadataDirectoryName,
          portableSeaShardInstanceFileName,
        ),
        "utf8",
      ),
    ) as PortableSeaShardInstanceManifest;
    assert.equal(renamedManifest.name, "Survival");
    const managedInstance = instances.find(({ id }) => id === "instance-1")!;
    const firstWorldInstance = await manager.ensureWorldStorageDirectory(managedInstance.id);
    const secondWorldInstance = await manager.ensureWorldStorageDirectory(managedInstance.id);
    assert.match(firstWorldInstance.worldStorageDirectoryName!, /^worlds-[a-z0-9]{6}$/u);
    assert.equal(
      secondWorldInstance.worldStorageDirectoryName,
      firstWorldInstance.worldStorageDirectoryName,
    );
    assert.equal(
      await access(
        join(firstWorldInstance.rootPath, firstWorldInstance.worldStorageDirectoryName!),
      ).then(
        () => true,
        () => false,
      ),
      true,
    );
    const persistedWorldManifest = JSON.parse(
      await readFile(
        join(
          firstWorldInstance.rootPath,
          portableInstanceMetadataDirectoryName,
          portableSeaShardInstanceFileName,
        ),
        "utf8",
      ),
    ) as PortableSeaShardInstanceManifest;
    assert.equal(
      persistedWorldManifest.worldStorageDirectoryName,
      firstWorldInstance.worldStorageDirectoryName,
    );
    const guardedWorldId = "guarded-world";
    const guardedWorldDirectory = join(managedInstance.rootPath, guardedWorldId);
    const guardedDatapackDirectory = join(guardedWorldDirectory, "datapacks");
    await mkdir(guardedDatapackDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        join(guardedWorldDirectory, "level.dat"),
        gzipSync(createDatapackLevelDat("Guarded World")),
      ),
      writeFile(
        join(guardedDatapackDirectory, "guarded.zip"),
        zipSync({
          "pack.mcmeta": strToU8(
            JSON.stringify({ pack: { pack_format: 48, description: "运行锁测试" } }),
          ),
        }),
      ),
    ]);
    // 左侧写操作先登记实例队列；并发启动预留必须等到 level.dat 事务完整提交。
    const [disabledDatapack] = await Promise.all([
      manager.setWorldDatapackDisabled(managedInstance.id, guardedWorldId, "guarded.zip", true),
      runtimeGate.reserve(managedInstance.id),
    ]);
    assert.equal(disabledDatapack.disabled, true);
    await Promise.all([
      assert.rejects(
        manager.setModDisabled(managedInstance.id, "mods/missing.jar", true),
        /服务器正在运行，无法切换 MOD 状态/u,
      ),
      assert.rejects(
        manager.deleteMod(managedInstance.id, "mods/missing.jar"),
        /服务器正在运行，无法删除 MOD/u,
      ),
      assert.rejects(manager.delete(managedInstance.id), /服务器正在运行，无法删除服务器实例/u),
    ]);
    await assert.rejects(
      manager.setWorldDatapackDisabled(managedInstance.id, guardedWorldId, "guarded.zip", false),
      /服务器正在运行，无法修改世界数据包/u,
    );
    await Promise.all([
      assert.rejects(
        manager.deleteWorldDatapack(managedInstance.id, guardedWorldId, "guarded.zip"),
        /服务器正在运行，无法删除世界数据包/u,
      ),
      assert.rejects(
        manager.switchWorld(managedInstance.id, guardedWorldId),
        /服务器正在运行，无法切换世界/u,
      ),
      assert.rejects(
        manager.createWorldBackup(managedInstance.id, guardedWorldId),
        /服务器正在运行，无法创建世界备份/u,
      ),
      assert.rejects(
        manager.restoreWorldBackup(managedInstance.id, guardedWorldId, "missing.zip"),
        /服务器正在运行，无法恢复世界备份/u,
      ),
      assert.rejects(
        manager.deleteWorldBackup(managedInstance.id, guardedWorldId, "missing.zip"),
        /服务器正在运行，无法删除世界备份/u,
      ),
    ]);
    await runtimeGate.release(managedInstance.id);
    const enabledDatapack = await manager.setWorldDatapackDisabled(
      managedInstance.id,
      guardedWorldId,
      "guarded.zip",
      false,
    );
    assert.equal(enabledDatapack.disabled, false);

    const countedInstance = instances[0]!;
    await Promise.all([
      mkdir(join(countedInstance.rootPath, "mods"), { recursive: true }),
      mkdir(join(countedInstance.rootPath, "server", "mods"), { recursive: true }),
      mkdir(join(countedInstance.rootPath, "plugins"), { recursive: true }),
    ]);
    const modArchive = zipSync({
      "fabric.mod.json": strToU8(
        JSON.stringify({
          id: "server-tools",
          name: "服务器工具",
          version: "1.2.3",
          description: "服务端工具简介",
          icon: "assets/server-tools/icon.png",
        }),
      ),
      "assets/server-tools/icon.png": Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]),
    });
    await Promise.all([
      writeFile(join(countedInstance.rootPath, "mods", "fabric-api.jar"), modArchive),
      writeFile(join(countedInstance.rootPath, "server", "mods", "quilted-fabric-api.JAR"), ""),
      writeFile(join(countedInstance.rootPath, "mods", "disabled.jar.disabled"), ""),
      writeFile(join(countedInstance.rootPath, "plugins", "luckperms.jar"), ""),
      writeFile(join(countedInstance.rootPath, "plugins", "config.yml"), ""),
    ]);
    assert.deepEqual(await manager.contentCounts(countedInstance.id), {
      mods: 2,
      plugins: 1,
    });
    await assert.rejects(manager.contentCounts("missing-instance"), /was not found/u);
    const firstStartupDefaults: ServerInstanceStartupSettings = {
      minimumMemoryMiB: 1_024,
      maximumMemoryMiB: 2_048,
      serverPort: 25_566,
      autoAcceptEula: true,
      jvmArguments: "",
    };
    const materializedInstance = await manager.ensureStartupSettings(
      countedInstance.id,
      firstStartupDefaults,
    );
    assert.deepEqual(materializedInstance.startupSettings, firstStartupDefaults);
    const preservedInstance = await manager.ensureStartupSettings(
      countedInstance.id,
      instanceStartupSettings,
    );
    assert.deepEqual(preservedInstance.startupSettings, firstStartupDefaults);
    const materializedManifest = JSON.parse(
      await readFile(
        join(
          countedInstance.rootPath,
          portableInstanceMetadataDirectoryName,
          portableSeaShardInstanceFileName,
        ),
        "utf8",
      ),
    ) as PortableSeaShardInstanceManifest;
    assert.deepEqual(materializedManifest.startupSettings, firstStartupDefaults);

    const updatedInstance = await manager.setStartupSettings(
      countedInstance.id,
      instanceStartupSettings,
    );
    assert.deepEqual(updatedInstance.startupSettings, instanceStartupSettings);
    const updatedManifest = JSON.parse(
      await readFile(
        join(
          countedInstance.rootPath,
          portableInstanceMetadataDirectoryName,
          portableSeaShardInstanceFileName,
        ),
        "utf8",
      ),
    ) as PortableSeaShardInstanceManifest;
    assert.deepEqual(updatedManifest.startupSettings, instanceStartupSettings);
    await manager.recordResourceSource(countedInstance.id, {
      resourceType: "mod",
      relativePath: "mods/fabric-api.jar",
      source: "modrinth",
      id: "server-mod-1",
      iconUrl: "https://cdn.modrinth.com/data/server-mod-1/icon.webp",
    });
    const resourceManifest = JSON.parse(
      await readFile(
        join(
          countedInstance.rootPath,
          portableInstanceMetadataDirectoryName,
          portableSeaShardInstanceFileName,
        ),
        "utf8",
      ),
    ) as PortableSeaShardInstanceManifest;
    assert.deepEqual(resourceManifest.resourceSources, {
      mods: {
        "mods/fabric-api.jar": {
          source: "modrinth",
          id: "server-mod-1",
          iconUrl: "https://cdn.modrinth.com/data/server-mod-1/icon.webp",
        },
      },
    });
    assert.deepEqual(
      (await manager.list()).find(({ id }) => id === countedInstance.id)?.resourceSources,
      resourceManifest.resourceSources,
    );
    const installedMod = (await manager.listMods(countedInstance.id)).find(
      ({ relativePath }) => relativePath === "mods/fabric-api.jar",
    );
    assert.deepEqual(
      installedMod && {
        name: installedMod.name,
        version: installedMod.version,
        description: installedMod.description,
        disabled: installedMod.disabled,
        resourceSource: installedMod.resourceSource,
      },
      {
        name: "服务器工具",
        version: "1.2.3",
        description: "服务端工具简介",
        disabled: false,
        resourceSource: {
          source: "modrinth",
          id: "server-mod-1",
          iconUrl: "https://cdn.modrinth.com/data/server-mod-1/icon.webp",
        },
      },
    );
    assert.equal(
      installedMod?.iconDataUrl,
      `data:image/png;base64,${Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]).toString("base64")}`,
    );
    const disabledMod = await manager.setModDisabled(
      countedInstance.id,
      "mods/fabric-api.jar",
      true,
    );
    assert.equal(disabledMod.relativePath, "mods/fabric-api.jar.disabled");
    assert.equal(disabledMod.disabled, true);
    assert.equal(
      await access(join(countedInstance.rootPath, "mods", "fabric-api.jar.disabled")).then(
        () => true,
        () => false,
      ),
      true,
    );
    const disabledManifest = JSON.parse(
      await readFile(
        join(
          countedInstance.rootPath,
          portableInstanceMetadataDirectoryName,
          portableSeaShardInstanceFileName,
        ),
        "utf8",
      ),
    ) as PortableSeaShardInstanceManifest;
    assert.deepEqual(disabledManifest.resourceSources?.mods, {
      "mods/fabric-api.jar.disabled": {
        source: "modrinth",
        id: "server-mod-1",
        iconUrl: "https://cdn.modrinth.com/data/server-mod-1/icon.webp",
      },
    });
    const enabledMod = await manager.setModDisabled(
      countedInstance.id,
      "mods/fabric-api.jar.disabled",
      false,
    );
    assert.equal(enabledMod.relativePath, "mods/fabric-api.jar");
    assert.deepEqual(enabledMod.resourceSource, {
      source: "modrinth",
      id: "server-mod-1",
      iconUrl: "https://cdn.modrinth.com/data/server-mod-1/icon.webp",
    });
    await manager.deleteMod(countedInstance.id, "mods/fabric-api.jar");
    await assert.rejects(access(join(countedInstance.rootPath, "mods", "fabric-api.jar")), {
      code: "ENOENT",
    });
    const deletedManifest = JSON.parse(
      await readFile(
        join(
          countedInstance.rootPath,
          portableInstanceMetadataDirectoryName,
          portableSeaShardInstanceFileName,
        ),
        "utf8",
      ),
    ) as PortableSeaShardInstanceManifest;
    assert.equal(deletedManifest.resourceSources, undefined);
    await assert.rejects(
      manager.setStartupSettings(countedInstance.id, {
        ...instanceStartupSettings,
        minimumMemoryMiB: 8_192,
      }),
      /minimum memory must not exceed maximum memory/,
    );
    const customIconDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const customIconBytes = Buffer.from(customIconDataUrl.split(",")[1]!, "base64");
    const customIconInstance = await manager.setIcon(countedInstance.id, customIconDataUrl);
    assert.notEqual(customIconInstance.iconPath, countedInstance.iconPath);
    assert.deepEqual(await readFile(customIconInstance.iconPath!), customIconBytes);
    await assert.rejects(access(countedInstance.iconPath!), { code: "ENOENT" });
    const customIconManifest = JSON.parse(
      await readFile(
        join(
          countedInstance.rootPath,
          portableInstanceMetadataDirectoryName,
          portableSeaShardInstanceFileName,
        ),
        "utf8",
      ),
    ) as PortableSeaShardInstanceManifest;
    assert.match(customIconManifest.icon ?? "", /^icon-[a-z0-9]{6}\.png$/u);
    let persistedInstances = await manager.list();
    persistedInstances = persistedInstances.map((instance) =>
      instance.id === customIconInstance.id ? customIconInstance : instance,
    );
    assert.deepEqual(coreContents, new Set(["core-task-1\n", "core-task-2\n"]));
    assert.deepEqual(
      new Set(await registry.listManifestPaths()),
      new Set(
        instances.map(({ rootPath }) =>
          join(rootPath, portableInstanceMetadataDirectoryName, portableSeaShardInstanceFileName),
        ),
      ),
    );

    let markGateOperationStarted!: () => void;
    let releaseGateOperation!: () => void;
    const gateOperationStarted = new Promise<void>((resolveStarted) => {
      markGateOperationStarted = resolveStarted;
    });
    const gateOperationRelease = new Promise<void>((resolveRelease) => {
      releaseGateOperation = resolveRelease;
    });
    const heldGateOperation = runtimeGate.runWhileStopped(
      managedInstance.id,
      "执行测试操作",
      async () => {
        markGateOperationStarted();
        await gateOperationRelease;
      },
    );
    await gateOperationStarted;
    const queuedMutation = manager.setWorldDatapackDisabled(
      managedInstance.id,
      guardedWorldId,
      "guarded.zip",
      true,
    );
    const queuedMutationRejection = assert.rejects(
      queuedMutation,
      /server instance manager is stopped/u,
    );
    await manager.dispose();
    releaseGateOperation();
    await heldGateOperation;
    await queuedMutationRejection;
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
      persistedInstances,
      "实例专属启动设置必须随可移植 JSON 跨重启保留",
    );

    const deletedInstance = persistedInstances[0]!;
    await reloadedManager.delete(deletedInstance.id);
    await assert.rejects(access(deletedInstance.rootPath), { code: "ENOENT" });
    assert.deepEqual(
      (await reloadedManager.list()).map(({ id }) => id),
      persistedInstances.slice(1).map(({ id }) => id),
    );
    assert.deepEqual(
      await registry.listManifestPaths(),
      persistedInstances
        .slice(1)
        .map(({ rootPath }) =>
          join(rootPath, portableInstanceMetadataDirectoryName, portableSeaShardInstanceFileName),
        ),
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
      source: "downloaded",
      storageMode: "managed",
      modLoader: null,
      serverType: "paper",
      gameVersion: "1.21.1",
      coreArtifactFileName: "paper-1.21.1-131.jar",
      artifactSha256: artifactHash,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      lastStartedAt: "2026-08-16T01:00:00.000Z",
      totalRuntimeMs: 3_600_000,
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
    assert.equal(reloaded?.totalRuntimeMs, 3_600_000);
    await manager.recordStartedAt("json-authority", "2026-08-18T08:30:00.000Z");
    const [startedInstance] = await manager.list();
    assert.equal(startedInstance?.lastStartedAt, "2026-08-18T08:30:00.000Z");
    assert.equal(startedInstance?.updatedAt, "2026-08-18T08:30:00.000Z");
    assert.equal(startedInstance?.totalRuntimeMs, 3_600_000);
    const startedManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as PortableSeaShardInstanceManifest;
    assert.equal(startedManifest.lastStartedAt, "2026-08-18T08:30:00.000Z");
    assert.equal(startedManifest.totalRuntimeMs, 3_600_000);
    await manager.recordRuntime(
      "json-authority",
      "2026-08-18T09:00:00.000Z",
      "2026-08-18T09:01:01.000Z",
    );
    const [runtimeInstance] = await manager.list();
    assert.equal(runtimeInstance?.totalRuntimeMs, 3_661_000);
    assert.equal(runtimeInstance?.updatedAt, "2026-08-18T09:01:01.000Z");
    const runtimeManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as PortableSeaShardInstanceManifest;
    assert.equal(runtimeManifest.totalRuntimeMs, 3_661_000);
    await assert.rejects(
      manager.recordRuntime(
        "json-authority",
        "2026-08-18T09:01:01.000Z",
        "2026-08-18T09:00:00.000Z",
      ),
      /stoppedAt must not precede startedAt/,
    );
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
      name: "1.21.1-arclight-fabric",
      rootPath,
      coreJarPath,
      source: "downloaded",
      storageMode: "managed",
      modLoader: "fabric",
      serverType: request.serverType,
      gameVersion: request.gameVersion,
      artifactSha256: artifactHash,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    } as const;
    const manifestPath = await writePortableInstanceManifests(legacyInstance);
    const serverInformationPath = join(dirname(manifestPath), portableServerInformationFileName);
    const { modLoader: _legacyModLoader, ...legacyServerInformation } = JSON.parse(
      await readFile(serverInformationPath, "utf8"),
    ) as PortableServerInformationManifest;
    await writeFile(
      serverInformationPath,
      `${JSON.stringify(legacyServerInformation, null, 2)}\n`,
      "utf8",
    );
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
    assert.equal(instance?.modLoader, "fabric");
    assert.deepEqual(await readFile(instance!.iconPath!), iconBytes);
    const manifest = JSON.parse(
      await readFile(join(metadataDirectory, portableSeaShardInstanceFileName), "utf8"),
    ) as PortableSeaShardInstanceManifest;
    assert.equal(manifest.icon, "icon.png");
    const backfilledServerInformation = JSON.parse(
      await readFile(serverInformationPath, "utf8"),
    ) as PortableServerInformationManifest;
    assert.equal(backfilledServerInformation.modLoader, "fabric");
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

function createDatapackLevelDat(levelName: string): Uint8Array {
  const bytes: number[] = [10, 0, 0];
  pushNamedNbtCompound(bytes, "Data");
  pushNamedNbtString(bytes, "LevelName", levelName);
  pushNamedNbtCompound(bytes, "DataPacks");
  pushNamedNbtStringList(bytes, "Enabled", ["vanilla"]);
  pushNamedNbtStringList(bytes, "Disabled", []);
  bytes.push(0, 0, 0);
  return Uint8Array.from(bytes);
}

function pushNamedNbtCompound(bytes: number[], name: string): void {
  bytes.push(10);
  pushNbtString(bytes, name);
}

function pushNamedNbtString(bytes: number[], name: string, value: string): void {
  bytes.push(8);
  pushNbtString(bytes, name);
  pushNbtString(bytes, value);
}

function pushNamedNbtStringList(bytes: number[], name: string, values: readonly string[]): void {
  bytes.push(9);
  pushNbtString(bytes, name);
  bytes.push(8);
  pushNbtInt32(bytes, values.length);
  for (const value of values) pushNbtString(bytes, value);
}

function pushNbtString(bytes: number[], value: string): void {
  const encoded = new TextEncoder().encode(value);
  bytes.push((encoded.byteLength >> 8) & 0xff, encoded.byteLength & 0xff, ...encoded);
}

function pushNbtInt32(bytes: number[], value: number): void {
  bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}
