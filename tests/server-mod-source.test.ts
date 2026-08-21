import assert from "node:assert/strict";
import test from "node:test";
import {
  serverModSearchLimits,
  type ServerInstanceSnapshot,
} from "../packages/contracts/src/index.ts";
import type {
  DownloadService,
  DownloadTaskSnapshot,
  StartDownloadRequest,
} from "../components/network/download/src/index.ts";
import type { ServerInstanceManagerService } from "../components/server/instance-manager/src/index.ts";
import {
  ModrinthServerModCatalog,
  ServerModDownloadCoordinator,
} from "../components/server/mod-source/src/index.ts";
import { resolve } from "node:path";

const apiBaseUrl = "https://api.modrinth.test/v2/";
const userAgent = "SeaShard/0.0.0-test";

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
}

class FakeDownloadService implements DownloadService {
  readonly requests: StartDownloadRequest[] = [];
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

  async cancel(): Promise<boolean> {
    return false;
  }
}

function instanceService(
  instances: readonly ServerInstanceSnapshot[],
): ServerInstanceManagerService {
  return {
    createManaged: async () => {
      throw new Error("not implemented in fixture");
    },
    list: async () => instances,
    contentCounts: async () => ({ mods: 0, plugins: 0 }),
    setStartupSettings: async () => {
      throw new Error("not implemented in fixture");
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

function searchRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
          body: "Complete project description.\n\nSecond paragraph.",
        });
      }
      if (url.pathname.endsWith("/project/server-mod-1/version")) {
        return Response.json([
          {
            id: "version-neoforge-1",
            project_id: "server-mod-1",
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
    projectId: "server-mod-1",
    body: "Complete project description.\n\nSecond paragraph.",
    versions: [
      {
        id: "version-neoforge-1",
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
  const coordinator = new ServerModDownloadCoordinator(
    catalog,
    downloads,
    instanceService([fabricInstance, forgeInstance]),
  );

  assert.deepEqual(
    await coordinator.installToInstance({
      resourceType: "mod",
      projectId: "server-mod-1",
      versionId: "version-fabric-1",
      instanceId: "fabric-instance",
      connections: 8,
    }),
    {
      resourceType: "mod",
      projectId: "server-mod-1",
      versionId: "version-fabric-1",
      fileName,
      destination: "instance",
      instanceId: "fabric-instance",
      downloadedBytes: 1_024,
    },
  );
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
      projectId: "server-mod-1",
      versionId: "version-fabric-1",
      destinationDirectory: saveDirectory,
      connections: 4,
    }),
    {
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

await test("Datapacks install into any exact-version instance and modpack downloads stay disabled", async () => {
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
    projectId: "server-datapack-1",
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

  const instanceRoot = resolve("test-fixtures/server-resource/paper-instance");
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
  const coordinator = new ServerModDownloadCoordinator(
    catalog,
    downloads,
    instanceService([matchingInstance, mismatchedInstance]),
  );

  assert.deepEqual(
    await coordinator.installToInstance({
      resourceType: "datapack",
      projectId: "server-datapack-1",
      versionId: "datapack-version-1",
      instanceId: "paper-instance",
      connections: 8,
    }),
    {
      resourceType: "datapack",
      projectId: "server-datapack-1",
      versionId: "datapack-version-1",
      fileName,
      destination: "instance",
      instanceId: "paper-instance",
      downloadedBytes: 2_048,
    },
  );
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
      resourceType: "datapack",
      projectId: "server-datapack-1",
      versionId: "datapack-version-1",
      instanceId: "paper-instance-old",
      connections: 8,
    }),
    /Minecraft 版本/u,
  );
  const requestsBeforeModpack = requests;
  await assert.rejects(
    coordinator.installToInstance({
      resourceType: "modpack",
      projectId: "server-modpack-1",
      versionId: "modpack-version-1",
      instanceId: "paper-instance",
      connections: 8,
    }),
    /modpack download is not available/u,
  );
  assert.equal(
    requests,
    requestsBeforeModpack,
    "disabled modpack download must not reach Modrinth",
  );
});
