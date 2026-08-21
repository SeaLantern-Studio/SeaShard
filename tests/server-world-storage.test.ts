import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { extractWorldArchive } from "../components/server/mod-source/src/world-storage.ts";
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
    const instances = {
      list: async () => [instance],
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
    const worldIds = ["outer", "inner"];
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
      [...(await readFile(join(root, "worlds-outer", "worlds-inner", "level.dat")))],
      [7, 8, 9],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("world directory collision preserves the existing directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "seashard-world-collision-"));
  try {
    const destination = join(root, "worlds-collision");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "keep.txt"), "existing");
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
    const coordinator = new ServerModDownloadCoordinator(
      { resolveVersionArtifact: async () => artifact } as unknown as ServerModCatalog,
      downloads,
      { list: async () => [instance] } as unknown as ServerInstanceManagerService,
      () => "collision",
    );

    await assert.rejects(
      coordinator.installToInstance({
        source: "modrinth",
        resourceType: "world",
        projectId: artifact.projectId,
        versionId: artifact.versionId,
        instanceId: instance.id,
      }),
    );
    assert.equal(await readFile(join(destination, "keep.txt"), "utf8"), "existing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
