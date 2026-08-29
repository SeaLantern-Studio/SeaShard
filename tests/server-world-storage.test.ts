import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { extractWorldArchive } from "../components/server/mod-source/src/world-storage.ts";
import { listWorldStorage } from "../components/server/instance-manager/src/world-storage.ts";
import { ServerModDownloadCoordinator } from "../components/server/mod-source/src/download-coordinator.ts";
import type {
  ServerModArtifact,
  ServerModCatalog,
} from "../components/server/mod-source/src/catalog-types.ts";
import type { ServerInstanceSnapshot } from "../packages/contracts/src/index.ts";
import type {
  DownloadService,
  DownloadTaskSnapshot,
  StartDownloadRequest,
} from "../components/network/download/src/index.ts";
import type { ServerInstanceManagerService } from "../components/server/instance-manager/src/index.ts";

await test("world archive extraction strips one wrapper directory and preserves files", async () => {
  const root = await mkdtemp(join(tmpdir(), "seashard-world-storage-"));
  const archivePath = join(root, "world.zip");
  const outputPath = join(root, "extracted");
  try {
    await writeFile(
      archivePath,
      zipSync({
        "SkyBlock/level.dat": new Uint8Array([1, 2, 3]),
        "SkyBlock/region/r.0.0.mca": new Uint8Array([4, 5]),
      }),
    );
    await extractWorldArchive(archivePath, outputPath);
    assert.deepEqual([...(await readFile(join(outputPath, "level.dat")))], [1, 2, 3]);
    assert.deepEqual([...(await readFile(join(outputPath, "region", "r.0.0.mca")))], [4, 5]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("world archive extraction rejects traversal entries before writing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "seashard-world-storage-"));
  const archivePath = join(root, "world.zip");
  const outputPath = join(root, "extracted");
  try {
    await writeFile(archivePath, zipSync({ "../outside/level.dat": new Uint8Array([1]) }));
    await assert.rejects(extractWorldArchive(archivePath, outputPath), /世界存档路径不安全/u);
    await assert.rejects(access(join(root, "outside", "level.dat")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("world coordinator downloads and extracts without switching the active world", async () => {
  const root = await mkdtemp(join(tmpdir(), "seashard-world-install-"));
  try {
    await mkdir(join(root, "worlds"), { recursive: true });
    await writeFile(join(root, "worlds", "keep.txt"), "other core data");
    const archive = zipSync({
      "Adventure/level.dat": new Uint8Array([7, 8, 9]),
      "Adventure/region/r.0.0.mca": new Uint8Array([10]),
    });
    const instance: ServerInstanceSnapshot = {
      id: "fabric-world-instance",
      name: "Fabric World",
      rootPath: root,
      coreJarPath: join(root, "server.jar"),
      storageMode: "managed",
      source: "downloaded",
      modLoader: "fabric",
      serverType: "fabric",
      gameVersion: "1.21.1",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    const artifact: ServerModArtifact = {
      source: "modrinth",
      resourceType: "world",
      projectId: "world-project",
      iconUrl: "https://cdn.modrinth.com/data/world-project/icon.webp",
      versionId: "world-version",
      fileName: "adventure.zip",
      url: "https://cdn.example.test/adventure.zip",
      size: archive.byteLength,
      gameVersions: ["1.21.1"],
      loaders: [],
    };
    const catalog = {
      resolveVersionArtifact: async () => artifact,
    } as unknown as ServerModCatalog;
    const resourceRecords: unknown[] = [];
    const instances = {
      list: async () => [instance],
      recordResourceSource: async (_instanceId: string, record: unknown) => {
        resourceRecords.push(record);
      },
      ensureWorldStorageDirectory: async () => ({
        ...instance,
        worldStorageDirectoryName: "worlds-outer1",
      }),
    } as unknown as ServerInstanceManagerService;
    let startRequest: StartDownloadRequest | undefined;
    const downloads = {
      start: async (request: StartDownloadRequest) => {
        startRequest = request;
        await writeFile(request.destinationPath, archive);
        return {
          id: "world-task-1",
          url: request.url,
          destinationPath: request.destinationPath,
          state: "queued",
          downloadedBytes: 0,
          totalBytes: archive.byteLength,
          connections: request.connections ?? 0,
          progress: 0,
          createdAt: "2026-08-20T00:00:00.000Z",
        } satisfies DownloadTaskSnapshot;
      },
      wait: async () =>
        ({
          id: "world-task-1",
          url: artifact.url,
          destinationPath: startRequest?.destinationPath ?? "",
          state: "completed",
          downloadedBytes: archive.byteLength,
          totalBytes: archive.byteLength,
          connections: startRequest?.connections ?? 0,
          progress: 100,
          createdAt: "2026-08-20T00:00:00.000Z",
          finishedAt: "2026-08-20T00:00:01.000Z",
        }) satisfies DownloadTaskSnapshot,
    } as unknown as DownloadService;
    const worldIds = ["inner1"];
    const coordinator = new ServerModDownloadCoordinator(catalog, downloads, instances, () =>
      worldIds.shift()!,
    );
    const result = await coordinator.installToInstance({
      source: "modrinth",
      resourceType: "world",
      projectId: "world-project",
      versionId: "world-version",
      instanceId: instance.id,
    });

    assert.equal(result.destination, "instance");
    assert.equal(result.instanceId, instance.id);
    assert.equal(result.downloadedBytes, archive.byteLength);
    assert.equal(startRequest?.connections, 8);
    assert.equal(
      await access(join(root, "server.properties")).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(await readFile(join(root, "worlds", "keep.txt"), "utf8"), "other core data");
    assert.deepEqual(
      [...(await readFile(join(root, "worlds-outer1", "worlds-inner1", "level.dat")))],
      [7, 8, 9],
    );
    assert.deepEqual(resourceRecords, [
      {
        resourceType: "world",
        relativePath: "worlds-outer1/worlds-inner1",
        source: "modrinth",
        id: "world-project",
        iconUrl: "https://cdn.modrinth.com/data/world-project/icon.webp",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("Quilt world downloads use the server working directory and matching source key", async () => {
  const root = await mkdtemp(join(tmpdir(), "seashard-quilt-world-install-"));
  try {
    const serverRoot = join(root, "server");
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(serverRoot, "server.properties"), "level-name=existing\n");
    const archive = zipSync({
      "Adventure/level.dat": new Uint8Array([4, 5, 6]),
    });
    const instance: ServerInstanceSnapshot = {
      id: "quilt-world-instance",
      name: "Quilt World",
      rootPath: root,
      coreJarPath: join(root, "server.jar"),
      storageMode: "managed",
      source: "downloaded",
      modLoader: "quilt",
      serverType: "quilt",
      gameVersion: "1.21.1",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    const artifact: ServerModArtifact = {
      source: "curseforge",
      resourceType: "world",
      projectId: "quilt-world-project",
      versionId: "quilt-world-version",
      fileName: "adventure.zip",
      url: "https://cdn.example.test/quilt-adventure.zip",
      size: archive.byteLength,
      gameVersions: ["1.21.1"],
      loaders: [],
    };
    const resourceRecords: unknown[] = [];
    const instances = {
      list: async () => [instance],
      recordResourceSource: async (_instanceId: string, record: unknown) => {
        resourceRecords.push(record);
      },
      ensureWorldStorageDirectory: async () => ({
        ...instance,
        worldStorageDirectoryName: "worlds-a1b2c3",
      }),
    } as unknown as ServerInstanceManagerService;
    let startRequest: StartDownloadRequest | undefined;
    const downloads = {
      start: async (request: StartDownloadRequest) => {
        startRequest = request;
        await writeFile(request.destinationPath, archive);
        return {
          id: "quilt-world-task",
          url: request.url,
          destinationPath: request.destinationPath,
          state: "queued",
          downloadedBytes: 0,
          totalBytes: archive.byteLength,
          connections: request.connections ?? 0,
          progress: 0,
          createdAt: "2026-08-20T00:00:00.000Z",
        } satisfies DownloadTaskSnapshot;
      },
      wait: async () =>
        ({
          id: "quilt-world-task",
          url: artifact.url,
          destinationPath: startRequest?.destinationPath ?? "",
          state: "completed",
          downloadedBytes: archive.byteLength,
          totalBytes: archive.byteLength,
          connections: startRequest?.connections ?? 0,
          progress: 100,
          createdAt: "2026-08-20T00:00:00.000Z",
          finishedAt: "2026-08-20T00:00:01.000Z",
        }) satisfies DownloadTaskSnapshot,
    } as unknown as DownloadService;
    const worldIds = ["d4e5f6"];
    const coordinator = new ServerModDownloadCoordinator(
      { resolveVersionArtifact: async () => artifact } as unknown as ServerModCatalog,
      downloads,
      instances,
      () => worldIds.shift()!,
    );

    await coordinator.installToInstance({
      source: "curseforge",
      resourceType: "world",
      projectId: artifact.projectId,
      versionId: artifact.versionId,
      instanceId: instance.id,
    });

    assert.equal(
      startRequest?.destinationPath.startsWith(join(serverRoot, ".seashard-world-")),
      true,
    );
    assert.deepEqual(
      [...(await readFile(join(serverRoot, "worlds-a1b2c3", "worlds-d4e5f6", "level.dat")))],
      [4, 5, 6],
    );
    assert.equal(
      await access(join(root, "worlds-a1b2c3")).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      await readFile(join(serverRoot, "server.properties"), "utf8"),
      "level-name=existing\n",
    );
    assert.deepEqual(resourceRecords, [
      {
        resourceType: "world",
        relativePath: "worlds-a1b2c3/worlds-d4e5f6",
        source: "curseforge",
        id: "quilt-world-project",
      },
    ]);

    const snapshot = await listWorldStorage({
      ...instance,
      resourceSources: {
        worlds: {
          "worlds-a1b2c3/worlds-d4e5f6": {
            source: "curseforge",
            id: "quilt-world-project",
          },
        },
      },
    });
    assert.equal(snapshot.mode, "unified");
    assert.equal(snapshot.saves[0]?.id, "worlds-d4e5f6");
    assert.deepEqual(snapshot.saves[0]?.resourceSource, {
      source: "curseforge",
      id: "quilt-world-project",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("world inner directory collision retries within the persisted outer directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "seashard-world-collision-"));
  try {
    const container = join(root, "worlds-stable");
    const existingWorld = join(container, "worlds-abc123");
    await mkdir(existingWorld, { recursive: true });
    await writeFile(join(existingWorld, "keep.txt"), "existing");
    const archive = zipSync({ "Adventure/level.dat": new Uint8Array([1]) });
    const instance: ServerInstanceSnapshot = {
      id: "collision-instance",
      name: "Collision",
      rootPath: root,
      coreJarPath: join(root, "server.jar"),
      storageMode: "managed",
      source: "downloaded",
      modLoader: "fabric",
      serverType: "fabric",
      gameVersion: "1.21.1",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    const artifact: ServerModArtifact = {
      source: "modrinth",
      resourceType: "world",
      projectId: "world-project",
      versionId: "world-version",
      fileName: "adventure.zip",
      url: "https://cdn.example.test/adventure.zip",
      size: archive.byteLength,
      gameVersions: ["1.21.1"],
      loaders: [],
    };
    let startRequest: StartDownloadRequest | undefined;
    const downloads = {
      start: async (request: StartDownloadRequest) => {
        startRequest = request;
        await writeFile(request.destinationPath, archive);
        return {
          id: "world-collision-task",
          url: request.url,
          destinationPath: request.destinationPath,
          state: "queued",
          downloadedBytes: 0,
          totalBytes: archive.byteLength,
          connections: request.connections ?? 0,
          progress: 0,
          createdAt: "2026-08-20T00:00:00.000Z",
        } satisfies DownloadTaskSnapshot;
      },
      wait: async () =>
        ({
          id: "world-collision-task",
          url: artifact.url,
          destinationPath: startRequest?.destinationPath ?? "",
          state: "completed",
          downloadedBytes: archive.byteLength,
          totalBytes: archive.byteLength,
          connections: 8,
          progress: 100,
          createdAt: "2026-08-20T00:00:00.000Z",
          finishedAt: "2026-08-20T00:00:01.000Z",
        }) satisfies DownloadTaskSnapshot,
    } as unknown as DownloadService;
    const worldIds = ["abc123", "def456"];
    const coordinator = new ServerModDownloadCoordinator(
      { resolveVersionArtifact: async () => artifact } as unknown as ServerModCatalog,
      downloads,
      {
        list: async () => [instance],
        ensureWorldStorageDirectory: async () => ({
          ...instance,
          worldStorageDirectoryName: "worlds-stable",
        }),
        recordResourceSource: async () => {},
      } as unknown as ServerInstanceManagerService,
      () => worldIds.shift()!,
    );

    const result = await coordinator.installToInstance({
      source: "modrinth",
      resourceType: "world",
      projectId: artifact.projectId,
      versionId: artifact.versionId,
      instanceId: instance.id,
    });
    assert.equal(result.destination, "instance");
    assert.equal(result.instanceId, instance.id);
    assert.equal(await readFile(join(existingWorld, "keep.txt"), "utf8"), "existing");
    assert.deepEqual([...(await readFile(join(container, "worlds-def456", "level.dat")))], [1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
