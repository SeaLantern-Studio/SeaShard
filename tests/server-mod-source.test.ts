import assert from "node:assert/strict";
import test from "node:test";
import { serverModSearchLimits } from "../packages/contracts/src/index.ts";
import { ModrinthServerModCatalog } from "../components/server/mod-source/src/index.ts";

const apiBaseUrl = "https://api.modrinth.test/v2/";
const userAgent = "SeaShard/0.0.0-test";

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
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

  const [first, second] = await Promise.all([catalog.getFilters(), catalog.getFilters()]);
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

  assert.deepEqual(await catalog.getProjectDetails("server-mod-1"), {
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
  await assert.rejects(catalog.getProjectDetails("../invalid"), /project ID is invalid/);
  assert.equal(requests.length, 0);
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

await test("Modrinth catalog rejects unbounded pages and client-only search hits", async () => {
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
        offset: 0,
        limit: 20,
        total_hits: 1,
      });
    },
  });

  await assert.rejects(
    catalog.search(searchRequest({ limit: serverModSearchLimits.maximumPageSize + 1 })),
    /limit must be between/,
  );
  assert.equal(requests, 0, "invalid pagination must fail before any network request");
  await assert.rejects(
    catalog.search(searchRequest({ offset: 0 })),
    /no server-compatible environment/,
  );
  assert.equal(requests, 1);
  await assert.rejects(
    catalog.search(searchRequest({ offset: 0 })),
    /icon URL is outside the trusted CDN path/,
  );
  assert.equal(requests, 2);
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
