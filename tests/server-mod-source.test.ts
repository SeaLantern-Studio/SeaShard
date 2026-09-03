import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  serverModSearchLimits,
  type ServerInstanceSnapshot,
  type ServerModSearchRequest,
  type ServerResourceSourceRecord,
} from "../packages/contracts/src/index.ts";
import type {
  DownloadService,
  DownloadTaskSnapshot,
  StartDownloadRequest,
} from "../components/network/download/src/index.ts";
import type { ServerInstanceManagerService } from "../components/server/instance-manager/src/index.ts";
import {
  CurseForgeServerModCatalog,
  ModrinthServerModCatalog,
  ServerModDownloadCoordinator,
  ServerModSourceCatalog,
} from "../components/server/mod-source/src/index.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const apiBaseUrl = "https://api.modrinth.test/v2/";
const userAgent = "SeaShard/0.0.0-test";

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
}

class FakeDownloadService implements DownloadService {
  readonly requests: StartDownloadRequest[] = [];
  readonly failedUrls = new Set<string>();
  private readonly tasks = new Map<string, DownloadTaskSnapshot>();
  async start(request: StartDownloadRequest): Promise<DownloadTaskSnapshot> {
    this.requests.push(request);
    const id = `mod-task-${this.requests.length}`;
    const task: DownloadTaskSnapshot = {
      id,
      url: request.url,
      destinationPath: request.destinationPath,
      state: "queued",
      downloadedBytes: 0,
      totalBytes: request.expectedBytes ?? 0,
      connections: request.connections ?? 0,
      progress: 0,
      createdAt: "2026-08-20T00:00:00.000Z",
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    };
    this.tasks.set(id, task);
    return task;
  }

  async snapshot(taskId: string): Promise<DownloadTaskSnapshot | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async wait(taskId: string): Promise<DownloadTaskSnapshot | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (this.failedUrls.has(task.url)) {
      const failed: DownloadTaskSnapshot = {
        ...task,
        state: "failed",
        error: "fixture download failure",
        finishedAt: "2026-08-20T00:00:01.000Z",
      };
      this.tasks.set(taskId, failed);
      return failed;
    }
    const completed: DownloadTaskSnapshot = {
      ...task,
      state: "completed",
      downloadedBytes: task.totalBytes,
      progress: 100,
      finishedAt: "2026-08-20T00:00:01.000Z",
    };
    this.tasks.set(taskId, completed);
    return completed;
  }

  async listTasks(): Promise<readonly DownloadTaskSnapshot[]> {
    return [...this.tasks.values()];
  }

  async listUserVisibleTasks(): Promise<readonly []> {
    return [];
  }

  async cancel(): Promise<boolean> {
    return false;
  }
}

function instanceService(
  instances: readonly ServerInstanceSnapshot[],
  records: ServerResourceSourceRecord[] = [],
): ServerInstanceManagerService {
  return {
    createManaged: async () => {
      throw new Error("not implemented in fixture");
    },
    rename: async () => {
      throw new Error("not implemented in fixture");
    },
    list: async () => instances,
    listForClient: async () => instances,
    contentCounts: async () => ({ mods: 0, plugins: 0 }),
    listMods: async () => [],
    setModDisabled: async () => {
      throw new Error("not implemented in fixture");
    },
    deleteMod: async () => {
      throw new Error("not implemented in fixture");
    },
    listPlugins: async () => [],
    setPluginDisabled: async () => {
      throw new Error("not implemented in fixture");
    },
    deletePlugin: async () => {
      throw new Error("not implemented in fixture");
    },
    listWorldStorage: async () => {
      throw new Error("not implemented in fixture");
    },
    listWorldDatapacks: async () => [],
    setWorldDatapackDisabled: async () => {
      throw new Error("not implemented in fixture");
    },
    deleteWorldDatapack: async () => {
      throw new Error("not implemented in fixture");
    },
    createWorldBackup: async () => {
      throw new Error("not implemented in fixture");
    },
    listWorldBackups: async () => {
      throw new Error("not implemented in fixture");
    },
    restoreWorldBackup: async () => {
      throw new Error("not implemented in fixture");
    },
    deleteWorldBackup: async () => {
      throw new Error("not implemented in fixture");
    },
    switchWorld: async () => {
      throw new Error("not implemented in fixture");
    },
    ensureStartupSettings: async () => {
      throw new Error("not implemented in fixture");
    },
    setStartupSettings: async () => {
      throw new Error("not implemented in fixture");
    },
    setIcon: async () => {
      throw new Error("not implemented in fixture");
    },
    ensureWorldStorageDirectory: async (instanceId) => {
      const instance = instances.find(({ id }) => id === instanceId);
      if (!instance) throw new Error(`instance ${instanceId} not found`);
      return instance;
    },
    recordResourceSource: async (_instanceId, record) => {
      records.push(record);
    },
    recordStartedAt: async () => {},
    recordRuntime: async () => {},
    delete: async () => {},
    resolveIconPath: async () => null,
  };
}

function projectFixture(
  environment: readonly string[] = ["server_only"],
  iconUrl = "https://cdn.modrinth.com/data/server-mod-1/icon.webp",
): object {
  return {
    project_id: "server-mod-1",
    project_type: "mod",
    slug: "server-tools",
    author: "SeaLantern",
    title: "Server Tools",
    description: "Utilities for dedicated servers.",
    categories: ["forge", "utility"],
    versions: ["1.20.1", "1.21.1"],
    downloads: 12_345,
    follows: 678,
    date_modified: "2026-08-17T10:00:00Z",
    environment,
    icon_url: iconUrl,
  };
}

function searchRequest(overrides: Partial<ServerModSearchRequest> = {}): ServerModSearchRequest {
  return {
    resourceType: "mod",
    source: "modrinth",
    query: " server tools ",
    tag: "utility",
    index: "downloads",
    gameVersion: "1.21.1",
    loader: "forge",
    offset: 20,
    limit: serverModSearchLimits.pageSize,
    ...overrides,
  };
}

await test("Modrinth catalog caches filter metadata and exposes only server Mod filters", async () => {
  const requests: URL[] = [];
  const catalog = new ModrinthServerModCatalog({
    baseUrl: apiBaseUrl,
    userAgent,
    fetchProvider: () => async (input, init) => {
      const url = requestUrl(input);
      requests.push(url);
      assert.equal(new Headers(init?.headers).get("user-agent"), userAgent);
      assert.equal(new Headers(init?.headers).get("accept"), "application/json");
      if (url.pathname.endsWith("/tag/category")) {
        return Response.json([
          { name: "utility", project_type: "mod", header: "categories" },
          { name: "technology", project_type: "mod", header: "categories" },
          { name: "16x", project_type: "resourcepack", header: "resolutions" },
        ]);
      }
      if (url.pathname.endsWith("/tag/game_version")) {
        return Response.json([
          { version: "1.21.1", version_type: "release", date: "2024-08-08", major: false },
          { version: "1.21.1-rc1", version_type: "snapshot", date: "2024-08-01", major: false },
          { version: "1.20.1", version_type: "release", date: "2023-06-12", major: true },
        ]);
      }
      if (url.pathname.endsWith("/tag/loader")) {
        return Response.json([
          { name: "fabric", supported_project_types: ["mod", "modpack"] },
          { name: "forge", supported_project_types: ["mod", "modpack"] },
          { name: "bukkit", supported_project_types: ["mod", "plugin"] },
          { name: "canvas", supported_project_types: ["shader"] },
        ]);
      }
      return new Response("missing", { status: 404 });
    },
  });

  const [first, second] = await Promise.all([catalog.getFilters("mod"), catalog.getFilters("mod")]);
  assert.equal(first, second, "concurrent filter reads must share one metadata request set");
  assert.deepEqual(first.sources, [{ id: "modrinth", label: "Modrinth" }]);
  assert.deepEqual(first.tags, [
    { id: "technology", label: "科技" },
    { id: "utility", label: "实用工具" },
  ]);
  assert.deepEqual(first.versions, [
    { id: "1.21.1", label: "1.21.1" },
    { id: "1.20.1", label: "1.20.1" },
  ]);
  assert.deepEqual(first.loaders, [
    { id: "forge", label: "Forge" },
    { id: "fabric", label: "Fabric" },
  ]);
  assert.equal(requests.length, 3, "metadata must be cached instead of fetched for every page");
});

await test("Modrinth search builds fixed server facets and returns a bounded safe projection", async () => {
  let requestedUrl: URL | undefined;
  const catalog = new ModrinthServerModCatalog({
    baseUrl: apiBaseUrl,
    userAgent,
    fetchProvider: () => async (input) => {
      requestedUrl = requestUrl(input);
      return Response.json({
        hits: [projectFixture()],
        offset: 20,
        limit: serverModSearchLimits.pageSize,
        total_hits: 41,
      });
    },
  });

  const result = await catalog.search(searchRequest());
  assert.ok(requestedUrl);
  assert.equal(requestedUrl.pathname, "/v2/search");
  assert.equal(requestedUrl.searchParams.get("query"), "server tools");
  assert.equal(requestedUrl.searchParams.get("index"), "downloads");
  assert.equal(requestedUrl.searchParams.get("offset"), "20");
  assert.equal(requestedUrl.searchParams.get("limit"), "20");
  const facets = JSON.parse(requestedUrl.searchParams.get("facets") ?? "null") as string[][];
  assert.deepEqual(facets[0], ["project_type:mod"]);
  assert.deepEqual(facets[2], ["categories:utility"]);
  assert.deepEqual(facets[3], ["versions:1.21.1"]);
  assert.deepEqual(facets[4], ["categories:forge"]);
  assert.ok(facets[1]?.includes("environment:server_only"));
  assert.ok(facets[1]?.includes("environment:client_and_server"));
  assert.equal(facets.flat().includes("environment:client_only"), false);
  assert.deepEqual(result, {
    items: [
      {
        resourceType: "mod",
        source: "modrinth",
        id: "server-mod-1",
        slug: "server-tools",
        title: "Server Tools",
        iconUrl: "https://cdn.modrinth.com/data/server-mod-1/icon.webp",
        description: "Utilities for dedicated servers.",
        author: "SeaLantern",
        downloads: 12_345,
        follows: 678,
        dateModified: "2026-08-17T10:00:00Z",
        environment: ["server_only"],
        categories: ["forge", "utility"],
        versions: ["1.20.1", "1.21.1"],
      },
    ],
    offset: 20,
    limit: 20,
    total: 41,
  });
});

await test("MCIM fallback switches project detail groups without mixing sources", async () => {
  const officialBaseUrl = new URL(apiBaseUrl).origin;
  const fallbackBaseUrl = "https://mcim.modrinth.test/modrinth/v2/";
  const requests: URL[] = [];
  const project = {
    id: "server-mod-1",
    project_type: "mod",
    slug: "server-tools",
    title: "Server Tools",
    description: "Utilities for dedicated servers.",
    team: "SeaLantern",
    downloads: 12_345,
    followers: 678,
    updated: "2026-08-17T10:00:00Z",
    client_side: "required",
    server_side: "required",
    categories: ["forge", "utility"],
    game_versions: ["1.20.1", "1.21.1"],
    icon_url: "https://cdn.modrinth.com/data/server-mod-1/icon.webp",
    body: "MCIM project",
  };
  const versions = [
    {
      id: "version-fabric-1",
      project_id: "server-mod-1",
      game_versions: ["1.21.1"],
      loaders: ["fabric"],
      downloads: 10,
      date_published: "2026-08-17T11:00:00Z",
      files: [{ filename: "server-tools.jar", primary: true }],
    },
  ];
  const catalog = new ModrinthServerModCatalog({
    baseUrl: apiBaseUrl,
    fallbackBaseUrl,
    userAgent,
    fetchProvider: () => async (input) => {
      const url = requestUrl(input);
      requests.push(url);
      if (url.origin === officialBaseUrl && url.pathname.endsWith("/version")) {
        return new Response("official version unavailable", { status: 503 });
      }
      if (url.origin === officialBaseUrl) {
        return Response.json({ ...project, body: "official project" });
      }
      if (url.origin === "https://mcim.modrinth.test") {
        return url.pathname.endsWith("/version") ? Response.json(versions) : Response.json(project);
      }
      return new Response("missing", { status: 404 });
    },
  });

  const result = await catalog.getProjectDetails("mod", "server-mod-1");
  assert.equal(result.body, "MCIM project");
  assert.deepEqual(
    requests.map((url) => `${url.origin}${url.pathname}`),
    [
      "https://api.modrinth.test/v2/project/server-mod-1",
      "https://api.modrinth.test/v2/project/server-mod-1/version",
      "https://mcim.modrinth.test/modrinth/v2/project/server-mod-1",
      "https://mcim.modrinth.test/modrinth/v2/project/server-mod-1/version",
    ],
  );
});
await test("Modrinth project details expose the full body and primary version files", async () => {
  const requests: URL[] = [];
  const catalog = new ModrinthServerModCatalog({
    baseUrl: apiBaseUrl,
    userAgent,
    fetchProvider: () => async (input) => {
      const url = requestUrl(input);
      requests.push(url);
      if (url.pathname.endsWith("/project/server-mod-1")) {
        return Response.json({
          id: "server-mod-1",
          project_type: "mod",
          slug: "server-tools",
          title: "Server Tools",
          description: "Utilities for dedicated servers.",
          team: "SeaLantern",
          downloads: 12_345,
          followers: 678,
          updated: "2026-08-17T10:00:00Z",
          client_side: "required",
          server_side: "required",
          categories: ["forge", "utility"],
          game_versions: ["1.20.1", "1.21.1"],
          icon_url: "https://cdn.modrinth.com/data/server-mod-1/icon.webp",
          body: "Complete project description.\n\nSecond paragraph.",
        });
      }
      if (url.pathname.endsWith("/project/server-mod-1/version")) {
        return Response.json([
          {
            id: "version-neoforge-1",
            project_id: "server-mod-1",
            version_number: "1.21.1-1.0.0",
            game_versions: ["1.21.1"],
            loaders: ["neoforge"],
            downloads: 4_321,
            date_published: "2026-08-17T11:00:00Z",
            files: [
              { filename: "server-tools-sources.jar", primary: false },
              { filename: "server-tools-neoforge-1.21.1.jar", primary: true },
            ],
          },
        ]);
      }
      return new Response("missing", { status: 404 });
    },
  });

  assert.deepEqual(await catalog.getProjectDetails("mod", "server-mod-1"), {
    resourceType: "mod",
    source: "modrinth",
    projectId: "server-mod-1",
    project: {
      resourceType: "mod",
      source: "modrinth",
      id: "server-mod-1",
      slug: "server-tools",
      title: "Server Tools",
      iconUrl: "https://cdn.modrinth.com/data/server-mod-1/icon.webp",
      description: "Utilities for dedicated servers.",
      author: "SeaLantern",
      downloads: 12_345,
      follows: 678,
      dateModified: "2026-08-17T10:00:00Z",
      environment: ["client_and_server"],
      categories: ["forge", "utility"],
      versions: ["1.20.1", "1.21.1"],
    },
    body: "Complete project description.\n\nSecond paragraph.",
    versions: [
      {
        id: "version-neoforge-1",
        version: "1.21.1-1.0.0",
        gameVersions: ["1.21.1"],
        loaders: ["neoforge"],
        fileName: "server-tools-neoforge-1.21.1.jar",
        downloads: 4_321,
        datePublished: "2026-08-17T11:00:00Z",
      },
    ],
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.searchParams.get("include_changelog"), "false");

  requests.length = 0;
  await assert.rejects(catalog.getProjectDetails("mod", "../invalid"), /project ID is invalid/);
  assert.equal(requests.length, 0);
});

await test("Mod download coordinator installs only compatible versions and supports save-as", async () => {
  const sha512 = "a".repeat(128);
  const fileName = "server-tools-fabric-1.21.1.jar";
  const catalog = new ModrinthServerModCatalog({
    baseUrl: apiBaseUrl,
    userAgent,
    fetchProvider: () => async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/project/server-mod-1")) {
        return Response.json({
          id: "server-mod-1",
          project_type: "mod",
          server_side: "required",
          icon_url: "https://cdn.modrinth.com/data/server-mod-1/icon.webp",
        });
      }
      if (url.pathname.endsWith("/version/version-fabric-1")) {
        return Response.json({
          id: "version-fabric-1",
          project_id: "server-mod-1",
          game_versions: ["1.21.1"],
          loaders: ["fabric"],
          files: [
            {
              filename: fileName,
              primary: true,
              size: 1_024,
              hashes: { sha512, sha1: "b".repeat(40) },
              url: `https://cdn.modrinth.com/data/server-mod-1/versions/version-fabric-1/${fileName}`,
            },
          ],
        });
      }
      return new Response("missing", { status: 404 });
    },
  });
  const fabricRoot = resolve("test-fixtures/server-mod/fabric-instance");
  const fabricInstance: ServerInstanceSnapshot = {
    id: "fabric-instance",
    name: "1.21.1-fabric",
    rootPath: fabricRoot,
    coreJarPath: resolve(fabricRoot, "server.jar"),
    storageMode: "managed",
    source: "downloaded",
    modLoader: "fabric",
    serverType: "fabric",
    gameVersion: "1.21.1",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  const forgeRoot = resolve("test-fixtures/server-mod/forge-instance");
  const forgeInstance: ServerInstanceSnapshot = {
    ...fabricInstance,
    id: "forge-instance",
    name: "1.21.1-forge",
    rootPath: forgeRoot,
    coreJarPath: resolve(forgeRoot, "server.jar"),
    modLoader: "forge",
    serverType: "mohist",
  };
  const downloads = new FakeDownloadService();
  const sourceRecords: ServerResourceSourceRecord[] = [];
  const coordinator = new ServerModDownloadCoordinator(
    new ServerModSourceCatalog(catalog, catalog),
    downloads,
    instanceService([fabricInstance, forgeInstance], sourceRecords),
  );

  assert.deepEqual(
    await coordinator.installToInstance({
      source: "modrinth",
      resourceType: "mod",
      projectId: "server-mod-1",
      versionId: "version-fabric-1",
      instanceId: "fabric-instance",
      connections: 8,
    }),
    {
      resourceType: "mod",
      source: "modrinth",
      projectId: "server-mod-1",
      versionId: "version-fabric-1",
      fileName,
      destination: "instance",
      instanceId: "fabric-instance",
      downloadedBytes: 1_024,
    },
  );
  assert.deepEqual(sourceRecords, [
    {
      resourceType: "mod",
      relativePath: "mods/server-tools-fabric-1.21.1.jar",
      source: "modrinth",
      id: "server-mod-1",
      iconUrl: "https://cdn.modrinth.com/data/server-mod-1/icon.webp",
    },
  ]);
  assert.deepEqual(downloads.requests[0], {
    url: `https://cdn.modrinth.com/data/server-mod-1/versions/version-fabric-1/${fileName}`,
    destinationPath: resolve(fabricRoot, "mods", fileName),
    expectedBytes: 1_024,
    sha512,
    connections: 8,
    metadata: {
      resourceType: "mod",
      kind: "server-mod",
      userVisible: true,
      projectId: "server-mod-1",
      versionId: "version-fabric-1",
      fileName,
      instanceId: "fabric-instance",
    },
  });

  await assert.rejects(
    coordinator.installToInstance({
      resourceType: "mod",
      source: "modrinth",
      projectId: "server-mod-1",
      versionId: "version-fabric-1",
      instanceId: "forge-instance",
      connections: 8,
    }),
    /does not support|不支持 Forge/u,
  );
  assert.equal(downloads.requests.length, 1, "incompatible instances must not start a download");

  const saveDirectory = resolve("test-fixtures/server-mod/exports");
  assert.deepEqual(
    await coordinator.saveToDirectory({
      resourceType: "mod",
      source: "modrinth",
      projectId: "server-mod-1",
      versionId: "version-fabric-1",
      destinationDirectory: saveDirectory,
      connections: 4,
    }),
    {
      source: "modrinth",
      resourceType: "mod",
      projectId: "server-mod-1",
      versionId: "version-fabric-1",
      fileName,
      destination: "directory",
      downloadedBytes: 1_024,
    },
  );
  assert.equal(downloads.requests[1]?.destinationPath, resolve(saveDirectory, fileName));
  assert.equal(downloads.requests[1]?.connections, 4);
});

await test("Modrinth artifact resolution rejects unsupported projects and untrusted file URLs", async () => {
  let serverSide = "unsupported";
  let fileUrl =
    "https://cdn.modrinth.com/data/server-mod-1/versions/version-fabric-1/server-tools.jar";
  const catalog = new ModrinthServerModCatalog({
    baseUrl: apiBaseUrl,
    userAgent,
    fetchProvider: () => async (input) => {
      const url = requestUrl(input);
      return url.pathname.endsWith("/project/server-mod-1")
        ? Response.json({
            id: "server-mod-1",
            project_type: "mod",
            server_side: serverSide,
          })
        : Response.json({
            id: "version-fabric-1",
            project_id: "server-mod-1",
            game_versions: ["1.21.1"],
            loaders: ["fabric"],
            files: [
              {
                filename: "server-tools.jar",
                primary: true,
                size: 16,
                hashes: { sha512: "a".repeat(128), sha1: "b".repeat(40) },
                url: fileUrl,
              },
            ],
          });
    },
  });

  await assert.rejects(
    catalog.resolveVersionArtifact("mod", "server-mod-1", "version-fabric-1"),
    /not compatible with dedicated servers/,
  );
  serverSide = "required";
  fileUrl = "https://untrusted.invalid/server-tools.jar";
  await assert.rejects(
    catalog.resolveVersionArtifact("mod", "server-mod-1", "version-fabric-1"),
    /outside the trusted CDN path/,
  );
});

await test("MCIM file fallback preserves checksum and destination after failure", async () => {
  const fileName = "server-tools-fabric-1.21.1.jar";
  const sha512 = "c".repeat(128);
  const officialUrl = `https://cdn.modrinth.com/data/server-mod-1/versions/version-fabric-1/${fileName}`;
  const fallbackUrl = `https://mcim.modrinth.test/data/server-mod-1/versions/version-fabric-1/${fileName}`;
  const catalog = new ModrinthServerModCatalog({
    baseUrl: apiBaseUrl,
    fallbackFileBaseUrl: "https://mcim.modrinth.test/",
    userAgent,
    fetchProvider: () => async (input) => {
      const url = requestUrl(input);
      return url.pathname.endsWith("/project/server-mod-1")
        ? Response.json({
            id: "server-mod-1",
            project_type: "mod",
            server_side: "required",
          })
        : Response.json({
            id: "version-fabric-1",
            project_id: "server-mod-1",
            game_versions: ["1.21.1"],
            loaders: ["fabric"],
            files: [
              {
                filename: fileName,
                primary: true,
                size: 2_048,
                hashes: { sha512, sha1: "d".repeat(40) },
                url: officialUrl,
              },
            ],
          });
    },
  });
  const artifact = await catalog.resolveVersionArtifact("mod", "server-mod-1", "version-fabric-1");
  assert.equal(artifact.fallbackUrl, fallbackUrl);

  const downloads = new FakeDownloadService();
  downloads.failedUrls.add(officialUrl);
  const coordinator = new ServerModDownloadCoordinator(
    new ServerModSourceCatalog(catalog, catalog),
    downloads,
    instanceService([]),
  );
  const destinationDirectory = resolve("test-fixtures/server-mod/fallback-exports");
  await coordinator.saveToDirectory({
    resourceType: "mod",
    source: "modrinth",
    projectId: "server-mod-1",
    versionId: "version-fabric-1",
    destinationDirectory,
    connections: 8,
  });
  assert.deepEqual(
    downloads.requests.map(({ url, destinationPath, expectedBytes: bytes, sha512: hash }) => ({
      url,
      destinationPath,
      bytes,
      hash,
    })),
    [
      {
        url: officialUrl,
        destinationPath: resolve(destinationDirectory, fileName),
        bytes: 2_048,
        hash: sha512,
      },
      {
        url: fallbackUrl,
        destinationPath: resolve(destinationDirectory, fileName),
        bytes: 2_048,
        hash: sha512,
      },
    ],
  );
});

await test("Modrinth catalog treats a blank project icon URL as a missing optional icon", async () => {
  const catalog = new ModrinthServerModCatalog({
    baseUrl: apiBaseUrl,
    userAgent,
    fetchProvider: () => async () =>
      Response.json({
        hits: [projectFixture(["server_only"], "")],
        offset: 40,
        limit: 20,
        total_hits: 61,
      }),
  });

  const result = await catalog.search(searchRequest({ offset: 40 }));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.id, "server-mod-1");
  assert.equal(result.items[0]?.iconUrl, undefined);
});

await test("Modrinth catalog skips malformed search hits and preserves page progress", async () => {
  let requests = 0;
  const catalog = new ModrinthServerModCatalog({
    baseUrl: apiBaseUrl,
    userAgent,
    fetchProvider: () => async () => {
      requests += 1;
      const hit =
        requests === 1
          ? projectFixture(["client_only"])
          : projectFixture(["server_only"], "https://untrusted.invalid/icon.png");
      return Response.json({
        hits: [hit],
        offset: requests === 1 ? 0 : 20,
        limit: 20,
        total_hits: 21,
      });
    },
  });

  const first = await catalog.search(searchRequest({ offset: 0 }));
  assert.deepEqual(first.items, []);
  assert.equal(first.offset, 0);
  assert.equal(first.limit, 20);
  const second = await catalog.search(searchRequest({ offset: 20 }));
  assert.deepEqual(second.items, []);
  assert.equal(second.offset, 20);
  assert.equal(requests, 2);
});

await test("Modrinth datapacks normalize missing or unknown environments", async () => {
  const catalog = new ModrinthServerModCatalog({
    baseUrl: apiBaseUrl,
    userAgent,
    fetchProvider: () => async () => {
      const missingEnvironment = {
        ...projectFixture([]),
        project_id: "datapack-missing-environment",
        project_type: "mod",
        all_project_types: ["mod", "datapack"],
        icon_url: "",
      } as Record<string, unknown>;
      delete missingEnvironment.environment;
      return Response.json({
        hits: [
          missingEnvironment,
          {
            ...projectFixture(["legacy_environment"]),
            project_id: "datapack-unknown-environment",
            project_type: "mod",
            all_project_types: ["mod", "datapack"],
            icon_url: "",
          },
        ],
        offset: 0,
        limit: 20,
        total_hits: 2,
      });
    },
  });

  const result = await catalog.search(
    searchRequest({
      resourceType: "datapack",
      query: "",
      tag: "",
      loader: "",
      offset: 0,
    }),
  );
  assert.deepEqual(
    result.items.map((project) => project.environment),
    [["server_only"], ["server_only"]],
  );
});

await test("Modrinth catalog rejects a response whose offset does not match the request", async () => {
  const catalog = new ModrinthServerModCatalog({
    baseUrl: apiBaseUrl,
    userAgent,
    fetchProvider: () => async () =>
      Response.json({
        hits: [projectFixture()],
        offset: 0,
        limit: 20,
        total_hits: 21,
      }),
  });

  await assert.rejects(
    catalog.search(searchRequest({ offset: 20 })),
    /returned offset 0, expected 20/,
  );
});

await test("Modrinth catalog reports rate limiting without retry storms", async () => {
  let requests = 0;
  const catalog = new ModrinthServerModCatalog({
    baseUrl: apiBaseUrl,
    userAgent,
    fetchProvider: () => async () => {
      requests += 1;
      return new Response(null, { status: 429 });
    },
  });

  await assert.rejects(catalog.search(searchRequest({ offset: 0 })), /请求频率已达上限/);
  assert.equal(requests, 1);
});

await test("Modrinth uses resource-specific facets for modpacks and datapacks", async () => {
  const requestedUrls: URL[] = [];
  const catalog = new ModrinthServerModCatalog({
    baseUrl: apiBaseUrl,
    userAgent,
    fetchProvider: () => async (input) => {
      const url = requestUrl(input);
      requestedUrls.push(url);
      const facets = JSON.parse(url.searchParams.get("facets") ?? "[]") as string[][];
      const resourceType = facets.flat().includes("all_project_types:modpack")
        ? "modpack"
        : "datapack";
      return Response.json({
        hits: [
          {
            project_id: `server-${resourceType}-1`,
            project_type: resourceType === "datapack" ? "mod" : "modpack",
            all_project_types: resourceType === "datapack" ? ["mod", "datapack"] : ["modpack"],
            slug: `server-${resourceType}`,
            author: "SeaLantern",
            title: resourceType === "datapack" ? "Server Datapack" : "Server Modpack",
            description: "Resource description.",
            categories: ["adventure"],
            versions: ["1.21.1"],
            downloads: 100,
            follows: 10,
            date_modified: "2026-08-17T10:00:00Z",
            environment: [
              resourceType === "datapack" ? "server_only" : "client_only_server_optional",
            ],
            icon_url: "",
          },
        ],
        offset: 0,
        limit: 20,
        total_hits: 1,
      });
    },
  });

  const modpack = await catalog.search(
    searchRequest({
      resourceType: "modpack",
      query: "",
      tag: "adventure",
      loader: "fabric",
      offset: 0,
    }),
  );
  const datapack = await catalog.search(
    searchRequest({
      resourceType: "datapack",
      query: "",
      tag: "adventure",
      loader: "",
      offset: 0,
    }),
  );

  const modpackFacets = JSON.parse(
    requestedUrls[0]!.searchParams.get("facets") ?? "[]",
  ) as string[][];
  assert.deepEqual(modpackFacets, [
    ["all_project_types:modpack"],
    ["categories:adventure"],
    ["versions:1.21.1"],
    ["categories:fabric"],
  ]);
  const datapackFacets = JSON.parse(
    requestedUrls[1]!.searchParams.get("facets") ?? "[]",
  ) as string[][];
  assert.deepEqual(datapackFacets, [
    ["all_project_types:datapack"],
    ["categories:adventure"],
    ["versions:1.21.1"],
  ]);
  assert.equal(modpack.items[0]?.resourceType, "modpack");
  assert.equal(modpack.items[0]?.environment[0], "client_only_server_optional");
  assert.equal(datapack.items[0]?.resourceType, "datapack");
});

await test("Datapacks install into any exact-version instance and non-installable packs stay guarded", async () => {
  const sha512 = "d".repeat(128);
  const fileName = "server-datapack-1.21.1.zip";
  let requests = 0;
  const catalog = new ModrinthServerModCatalog({
    baseUrl: apiBaseUrl,
    userAgent,
    fetchProvider: () => async (input) => {
      requests += 1;
      const url = requestUrl(input);
      if (url.pathname.endsWith("/project/server-datapack-1")) {
        return Response.json({
          id: "server-datapack-1",
          project_type: "mod",
          loaders: ["datapack"],
          slug: "server-datapack",
          title: "Server Datapack",
          description: "A dedicated-server datapack.",
          team: "SeaLantern",
          downloads: 123,
          followers: 4,
          updated: "2026-08-17T10:00:00Z",
          client_side: "unknown",
          server_side: "required",
          categories: ["adventure"],
          game_versions: ["1.21.1"],
          icon_url: "https://cdn.modrinth.com/data/server-datapack-1/icon.webp",
          body: "A dedicated-server datapack.",
        });
      }
      if (url.pathname.endsWith("/project/server-datapack-1/version")) {
        return Response.json([
          {
            id: "datapack-version-1",
            project_id: "server-datapack-1",
            game_versions: ["1.21.1"],
            loaders: ["datapack"],
            downloads: 50,
            date_published: "2026-08-17T11:00:00Z",
            files: [{ filename: fileName, primary: true }],
          },
          {
            id: "mod-version-1",
            project_id: "server-datapack-1",
            game_versions: ["1.21.1"],
            loaders: ["fabric"],
            downloads: 40,
            date_published: "2026-08-16T11:00:00Z",
            files: [{ filename: "server-mod.jar", primary: true }],
          },
        ]);
      }
      if (url.pathname.endsWith("/version/datapack-version-1")) {
        return Response.json({
          id: "datapack-version-1",
          project_id: "server-datapack-1",
          version_number: "1.4.0",
          game_versions: ["1.21.1"],
          loaders: ["datapack"],
          files: [
            {
              filename: fileName,
              primary: true,
              size: 2_048,
              hashes: { sha512, sha1: "e".repeat(40) },
              url: `https://cdn.modrinth.com/data/server-datapack-1/versions/datapack-version-1/${fileName}`,
            },
          ],
        });
      }
      return new Response("missing", { status: 404 });
    },
  });
  assert.deepEqual(await catalog.getProjectDetails("datapack", "server-datapack-1"), {
    resourceType: "datapack",
    source: "modrinth",
    projectId: "server-datapack-1",
    project: {
      resourceType: "datapack",
      source: "modrinth",
      id: "server-datapack-1",
      slug: "server-datapack",
      title: "Server Datapack",
      iconUrl: "https://cdn.modrinth.com/data/server-datapack-1/icon.webp",
      description: "A dedicated-server datapack.",
      author: "SeaLantern",
      downloads: 123,
      follows: 4,
      dateModified: "2026-08-17T10:00:00Z",
      environment: ["server_only"],
      categories: ["adventure"],
      versions: ["1.21.1"],
    },
    body: "A dedicated-server datapack.",
    versions: [
      {
        id: "datapack-version-1",
        gameVersions: ["1.21.1"],
        loaders: ["datapack"],
        fileName,
        downloads: 50,
        datePublished: "2026-08-17T11:00:00Z",
      },
    ],
  });

  const instanceRoot = await mkdtemp(join(tmpdir(), "seashard-datapack-install-"));
  try {
    await mkdir(join(instanceRoot, "world"), { recursive: true });
    await writeFile(join(instanceRoot, "world", "level.dat"), Uint8Array.of(1));
    const matchingInstance: ServerInstanceSnapshot = {
      id: "paper-instance",
      name: "1.21.1-paper",
      rootPath: instanceRoot,
      coreJarPath: resolve(instanceRoot, "server.jar"),
      storageMode: "managed",
      source: "downloaded",
      modLoader: null,
      serverType: "paper",
      gameVersion: "1.21.1",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    const mismatchedInstance: ServerInstanceSnapshot = {
      ...matchingInstance,
      id: "paper-instance-old",
      name: "1.20.1-paper",
      gameVersion: "1.20.1",
    };
    const downloads = new FakeDownloadService();
    const sourceRecords: ServerResourceSourceRecord[] = [];
    const coordinator = new ServerModDownloadCoordinator(
      new ServerModSourceCatalog(catalog, catalog),
      downloads,
      instanceService([matchingInstance, mismatchedInstance], sourceRecords),
    );
    await assert.rejects(
      coordinator.installToInstance({
        source: "modrinth",
        resourceType: "datapack",
        projectId: "server-datapack-1",
        versionId: "datapack-version-1",
        instanceId: "paper-instance",
        connections: 8,
      }),
      /数据包安装必须指定目标存档/u,
    );
    await assert.rejects(
      coordinator.installToInstance({
        source: "modrinth",
        resourceType: "datapack",
        projectId: "server-datapack-1",
        versionId: "datapack-version-1",
        instanceId: "paper-instance",
        worldId: "missing-world",
        connections: 8,
      }),
      /目标存档不存在/u,
    );

    assert.deepEqual(
      await coordinator.installToInstance({
        source: "modrinth",
        resourceType: "datapack",
        projectId: "server-datapack-1",
        versionId: "datapack-version-1",
        instanceId: "paper-instance",
        worldId: "world",
        connections: 8,
      }),
      {
        source: "modrinth",
        resourceType: "datapack",
        projectId: "server-datapack-1",
        versionId: "datapack-version-1",
        fileName,
        destination: "instance",
        instanceId: "paper-instance",
        downloadedBytes: 2_048,
      },
    );
    assert.deepEqual(sourceRecords, [
      {
        resourceType: "datapack",
        relativePath: "world/datapacks/server-datapack-1.21.1.zip",
        source: "modrinth",
        id: "server-datapack-1",
        version: "1.4.0",
        iconUrl: "https://cdn.modrinth.com/data/server-datapack-1/icon.webp",
      },
    ]);
    assert.equal(
      downloads.requests[0]?.destinationPath,
      resolve(instanceRoot, "world", "datapacks", fileName),
    );
    assert.deepEqual(downloads.requests[0]?.metadata, {
      kind: "server-datapack",
      userVisible: true,
      resourceType: "datapack",
      projectId: "server-datapack-1",
      versionId: "datapack-version-1",
      fileName,
      instanceId: "paper-instance",
    });

    await assert.rejects(
      coordinator.installToInstance({
        source: "modrinth",
        resourceType: "datapack",
        projectId: "server-datapack-1",
        versionId: "datapack-version-1",
        instanceId: "paper-instance-old",
        worldId: "world",
        connections: 8,
      }),
      /Minecraft 版本/u,
    );
    const requestsBeforeModpack = requests;
    await assert.rejects(
      coordinator.installToInstance({
        source: "modrinth",
        resourceType: "modpack",
        projectId: "server-modpack-1",
        versionId: "modpack-version-1",
        instanceId: "paper-instance",
        connections: 8,
      }),
      /server resource type must be mod, datapack, or world/u,
    );
    assert.equal(
      requests,
      requestsBeforeModpack,
      "non-installable modpack requests must not reach Modrinth",
    );
  } finally {
    await rm(instanceRoot, { recursive: true, force: true });
  }
});

await test("CurseForge transient outages return fulfilled unavailable results", async () => {
  const catalog = new CurseForgeServerModCatalog({
    baseUrl: "https://mod.mcimirror.test/curseforge/v1/",
    userAgent,
    fetchProvider: () => async () => new Response(null, { status: 502 }),
  });
  const filters = await catalog.getFilters("mod");
  assert.equal(filters.sources[0]?.id, "curseforge");
  assert.equal(filters.unavailableReason, "CurseForge 暂时不可用，请稍后重试");

  const search = await catalog.search(searchRequest({ source: "curseforge", tag: "", offset: 20 }));
  assert.deepEqual(search, {
    items: [],
    offset: 20,
    limit: 0,
    total: 0,
    unavailableReason: "CurseForge 暂时不可用，请稍后重试",
  });
});
await test("CurseForge world 422034 keeps real details when its file list is transiently unavailable", async () => {
  const requested: URL[] = [];
  const embeddedFile = {
    id: 8_480_262,
    modId: 422_034,
    displayName: "Voidblock 26.2",
    fileName: "Voidblock.zip",
    fileLength: 12_345,
    downloadCount: 321,
    fileDate: "2026-08-18T12:00:00Z",
    gameVersions: ["26.2"],
    sortableGameVersions: [],
    hashes: [],
  };
  const catalog = new CurseForgeServerModCatalog({
    baseUrl: "https://mod.mcimirror.test/curseforge/v1/",
    userAgent,
    fetchProvider: () => async (input) => {
      const url = requestUrl(input);
      requested.push(url);
      if (url.pathname.endsWith("/mods/422034/files")) {
        return new Response(null, { status: 502 });
      }
      if (url.pathname.endsWith("/mods/422034")) {
        return Response.json({
          data: {
            id: 422_034,
            slug: "voidblock-skyblock-reinterpretation",
            name: "Voidblock - Skyblock",
            summary: "A skyblock world for Minecraft.",
            logo: { url: "https://media.forgecdn.net/avatars/422/034/voidblock.png" },
            authors: [{ name: "LoweredgamesMC" }],
            downloadCount: 2_126_809,
            dateModified: "2026-08-18T12:00:00Z",
            latestFilesIndexes: [{ gameVersion: "26.2" }],
            latestFiles: [embeddedFile],
            categories: [],
          },
        });
      }
      return new Response("missing", { status: 404 });
    },
  });

  const details = await catalog.getProjectDetails("world", "422034");
  assert.equal(details.project.resourceType, "world");
  assert.equal(details.project.title, "Voidblock - Skyblock");
  assert.equal(details.project.author, "LoweredgamesMC");
  assert.equal(details.project.iconUrl, "https://media.forgecdn.net/avatars/422/034/voidblock.png");
  assert.equal(details.project.downloads, 2_126_809);
  assert.equal(details.body, "A skyblock world for Minecraft.");
  assert.deepEqual(details.versions, [
    {
      id: "8480262",
      version: "Voidblock 26.2",
      gameVersions: ["26.2"],
      loaders: [],
      fileName: "Voidblock.zip",
      downloads: 321,
      datePublished: "2026-08-18T12:00:00Z",
    },
  ]);
  assert.deepEqual(
    requested.map((url) => url.pathname),
    ["/curseforge/v1/mods/422034", "/curseforge/v1/mods/422034/files"],
  );
});

await test("CurseForge MCIM catalog searches, reads details, and normalizes mirror downloads", async () => {
  const baseUrl = "https://mod.mcimirror.test/curseforge/v1/";
  const requested: URL[] = [];
  const fileName = "server-tools-fabric-1.21.1.jar";
  const sha1 = "a".repeat(40);
  const file = {
    id: 456,
    modId: 123,
    displayName: "Server Tools 1.21.1",
    fileName,
    fileLength: 2_048,
    downloadCount: 987,
    fileDate: "2026-08-18T12:00:00Z",
    gameVersions: ["1.21.1", "Fabric"],
    sortableGameVersions: [{ gameVersionName: "Fabric" }],
    hashes: [{ algo: 1, value: sha1 }],
  };
  const catalog = new CurseForgeServerModCatalog({
    baseUrl,
    userAgent,
    fetchProvider: () => async (input, init) => {
      const url = requestUrl(input);
      requested.push(url);
      assert.equal(new Headers(init?.headers).get("user-agent"), userAgent);
      if (url.pathname.endsWith("/mods/search")) {
        return Response.json({
          data: [
            {
              id: 123,
              slug: "server-tools",
              name: "Server Tools",
              summary: "Utilities for dedicated servers.",
              logo: { url: "https://media.forgecdn.net/ mod/icon.png".replace(" ", "") },
              authors: [{ name: "SeaLantern" }],
              downloadCount: 12_345,
              dateModified: "2026-08-17T10:00:00Z",
              latestFilesIndexes: [{ gameVersion: "1.21.1" }],
              categories: [{ name: "Utility" }],
            },
          ],
          pagination: { index: 0, pageSize: 20, totalCount: 1 },
        });
      }
      if (url.pathname.endsWith("/categories")) {
        return Response.json({ data: [{ id: 7, name: "Utility" }] });
      }
      if (url.pathname.endsWith("/mods/123/files/456/download-url")) {
        return Response.json({
          data: `https://edge.forgecdn.net/files/7091/801/${fileName}`,
        });
      }
      if (url.pathname.endsWith("/mods/123/files/456")) return Response.json({ data: file });
      if (url.pathname.endsWith("/mods/123/files")) return Response.json({ data: [file] });
      if (url.pathname.endsWith("/mods/123")) {
        return Response.json({
          id: 123,
          slug: "server-tools",
          name: "Server Tools",
          summary: "Utilities for dedicated servers.",
          logo: { url: "https://media.forgecdn.net/mod/icon.png" },
          authors: [{ name: "SeaLantern" }],
          downloadCount: 12_345,
          dateModified: "2026-08-17T10:00:00Z",
          latestFilesIndexes: [{ gameVersion: "1.21.1" }],
          categories: [{ name: "Utility" }],
          allowModDistribution: true,
          isAvailable: true,
        });
      }
      return new Response("missing", { status: 404 });
    },
  });

  const filters = await catalog.getFilters("mod");
  assert.deepEqual(filters.sources, [{ id: "curseforge", label: "CurseForge" }]);
  assert.deepEqual(filters.tags, [{ id: "7", label: "Utility" }]);

  const search = await catalog.search({
    source: "curseforge",
    resourceType: "mod",
    query: "server tools",
    tag: "7",
    index: "downloads",
    gameVersion: "1.21.1",
    loader: "fabric",
    offset: 0,
    limit: 20,
  });
  assert.equal(requested.at(-1)?.searchParams.get("gameId"), "432");
  assert.equal(requested.at(-1)?.searchParams.get("classId"), "6");
  assert.equal(requested.at(-1)?.searchParams.get("modLoaderType"), "4");
  assert.equal(search.items[0]?.source, "curseforge");
  assert.equal(search.items[0]?.id, "123");
  assert.equal(search.items[0]?.iconUrl, "https://media.forgecdn.net/mod/icon.png");
  const details = await catalog.getProjectDetails("mod", "123");
  assert.deepEqual(details.versions[0], {
    id: "456",
    version: "Server Tools 1.21.1",
    gameVersions: ["1.21.1"],
    loaders: ["fabric"],
    fileName,
    downloads: 987,
    datePublished: "2026-08-18T12:00:00Z",
  });

  const artifact = await catalog.resolveVersionArtifact("mod", "123", "456");
  assert.deepEqual(artifact, {
    source: "curseforge",
    resourceType: "mod",
    projectId: "123",
    iconUrl: "https://media.forgecdn.net/mod/icon.png",
    versionId: "456",
    version: "Server Tools 1.21.1",
    fileName,
    url: `https://mod.mcimirror.top/files/7091/801/${fileName}`,
    sha1,
    size: 2_048,
    gameVersions: ["1.21.1"],
    loaders: ["fabric"],
  });
});
await test("CurseForge uses resource class IDs and supports pack/world archives", async () => {
  const baseUrl = "https://mod.mcimirror.test/curseforge/v1/";
  const requested: URL[] = [];
  const catalog = new CurseForgeServerModCatalog({
    baseUrl,
    userAgent,
    fetchProvider: () => async (input) => {
      const url = requestUrl(input);
      requested.push(url);
      if (url.pathname.endsWith("/mods/search")) {
        const classId = url.searchParams.get("classId");
        const projectId = classId === "4471" ? 1606092 : classId === "17" ? 1620741 : 1694001;
        return Response.json({
          data: [
            {
              id: projectId,
              slug: `resource-${classId}`,
              name: `Resource ${classId}`,
              summary: "A downloadable Minecraft resource.",
              logo: { url: "https://media.forgecdn.net/avatars/resource.png" },
              authors: [{ name: "SeaLantern" }],
              downloadCount: 12,
              dateModified: "2026-08-18T12:00:00Z",
              latestFilesIndexes: [{ gameVersion: "1.21.1" }],
              categories: [],
            },
          ],
          pagination: { index: 0, pageSize: 20, totalCount: 1 },
        });
      }
      if (url.pathname.endsWith("/categories")) return new Response("missing", { status: 404 });
      if (url.pathname.endsWith("/mods/1606092")) {
        return Response.json({
          data: {
            id: 1606092,
            slug: "resource-4471",
            name: "Resource 4471",
            summary: "A modpack archive.",
            logo: { url: "https://media.forgecdn.net/avatars/resource.png" },
            authors: [{ name: "SeaLantern" }],
            downloadCount: 12,
            dateModified: "2026-08-18T12:00:00Z",
            latestFilesIndexes: [{ gameVersion: "1.21.1" }],
            categories: [],
            allowModDistribution: true,
            isAvailable: true,
          },
        });
      }
      if (url.pathname.endsWith("/mods/1606092/files")) {
        return Response.json({
          data: [
            {
              id: 2606092,
              modId: 1606092,
              fileName: "resource-pack.zip",
              fileLength: 4_096,
              downloadCount: 20,
              fileDate: "2026-08-18T12:00:00Z",
              gameVersions: ["1.21.1"],
              sortableGameVersions: [],
              hashes: [{ algo: 1, value: "b".repeat(40) }],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/mods/1606092/files/2606092/download-url")) {
        return Response.json({
          data: "https://edge.forgecdn.net/files/100/200/resource-pack.zip",
        });
      }
      if (url.pathname.endsWith("/mods/1606092/files/2606092")) {
        return Response.json({
          data: {
            id: 2606092,
            modId: 1606092,
            fileName: "resource-pack.zip",
            fileLength: 4_096,
            downloadCount: 20,
            fileDate: "2026-08-18T12:00:00Z",
            gameVersions: ["1.21.1"],
            sortableGameVersions: [],
            hashes: [{ algo: 1, value: "b".repeat(40) }],
          },
        });
      }
      return new Response("missing", { status: 404 });
    },
  });

  for (const [resourceType, classId] of [
    ["modpack", "4471"],
    ["datapack", "694"],
    ["world", "17"],
  ] as const) {
    const result = await catalog.search({
      source: "curseforge",
      resourceType,
      query: "",
      tag: "",
      index: "downloads",
      gameVersion: "",
      loader: "",
      offset: 0,
      limit: 20,
    });
    assert.equal(result.items[0]?.resourceType, resourceType);
    assert.equal(requested.at(-1)?.searchParams.get("classId"), classId);
  }

  const details = await catalog.getProjectDetails("modpack", "1606092");
  assert.equal(details.resourceType, "modpack");
  assert.equal(details.versions[0]?.fileName, "resource-pack.zip");

  const artifact = await catalog.resolveVersionArtifact("modpack", "1606092", "2606092");
  assert.equal(artifact.resourceType, "modpack");
  assert.equal(artifact.fileName, "resource-pack.zip");
  assert.equal(artifact.url, "https://mod.mcimirror.top/files/100/200/resource-pack.zip");
});
