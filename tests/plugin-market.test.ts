import assert from "node:assert/strict";
import test from "node:test";
import { PluginRegistryCatalog } from "../components/plugin/market/src/index.ts";

const catalogFixture = {
  schemaVersion: 1,
  plugins: [
    {
      id: "sea-author.example-plugin",
      name: "Example Plugin",
      summary: "Bridge scheduled commands into a server.",
      owners: ["sea-author"],
      source: {
        type: "github",
        repository: "sea-author/example-plugin",
        url: "https://github.com/sea-author/example-plugin",
      },
      license: "MIT",
      releases: [
        {
          version: "1.2.0",
          tag: "v1.2.0",
          releaseUrl: "https://github.com/sea-author/example-plugin/releases/tag/v1.2.0",
          downloadUrl:
            "https://github.com/sea-author/example-plugin/releases/download/v1.2.0/sea-author.example-plugin-1.2.0.seashard-plugin",
          archiveSha256: "a".repeat(64),
          packageDigest: "b".repeat(64),
          publisher: "sea-author",
          compatibility: {
            seaShard: ">=0.1.0 <1.0.0",
            clientProtocol: ">=1 <2",
          },
          entries: [
            {
              id: "example.host",
              runtime: "host",
              uses: {
                "seashard.server-runtime": ["get", "sendCommand"],
              },
              hostProfiles: ["electron"],
            },
            {
              id: "example.client",
              runtime: "client",
              uses: {
                "sea-author.example-plugin": ["listTasks"],
              },
              targets: ["desktop"],
            },
          ],
          fileCount: 3,
          unpackedSize: 4096,
          yanked: false,
        },
      ],
    },
  ],
};

await test("plugin market downloads one Release Catalog and searches it locally", async () => {
  const requests: URL[] = [];
  const catalog = new PluginRegistryCatalog({
    catalogUrl: "https://registry.test/releases/latest/download/catalog-v1.json",
    now: () => new Date("2026-08-27T12:00:00.000Z"),
    fetchProvider: () => async (input, init) => {
      const url = requestUrl(input);
      requests.push(url);
      assert.equal(url.href, "https://registry.test/releases/latest/download/catalog-v1.json");
      assert.equal(new Headers(init?.headers).get("accept"), "application/json");
      return Response.json(catalogFixture);
    },
  });

  const first = await catalog.search({ query: "bridge", page: 1, pageSize: 20 });
  const cached = await catalog.search({ query: "sea-author", page: 1, pageSize: 20 });
  const refreshed = await catalog.search({
    query: "example",
    page: 1,
    pageSize: 20,
    refresh: true,
  });

  assert.equal(requests.length, 2);
  assert.equal(first.totalCount, 1);
  assert.equal(first.fetchedAt, "2026-08-27T12:00:00.000Z");
  assert.equal(first.plugins[0]?.id, "sea-author.example-plugin");
  assert.equal(cached.plugins[0]?.owners[0], "sea-author");
  assert.deepEqual(refreshed.plugins, first.plugins);
});

await test("plugin market accepts empty queries and paginates the static catalog", async () => {
  const catalog = new PluginRegistryCatalog({
    catalogUrl: "https://registry.test/catalog-v1.json",
    fetchProvider: () => async () => Response.json(catalogFixture),
  });

  const firstPage = await catalog.search({ query: "", page: 1, pageSize: 1 });
  const secondPage = await catalog.search({ query: "", page: 2, pageSize: 1 });

  assert.equal(firstPage.totalCount, 1);
  assert.equal(firstPage.plugins.length, 1);
  assert.equal(secondPage.totalCount, 1);
  assert.deepEqual(secondPage.plugins, []);
});

await test("plugin market keeps its last snapshot for automatic refresh failures", async () => {
  let now = new Date("2026-08-27T12:00:00.000Z");
  let fail = false;
  let requests = 0;
  const catalog = new PluginRegistryCatalog({
    catalogUrl: "https://registry.test/catalog-v1.json",
    cacheTtlMs: 1,
    now: () => now,
    fetchProvider: () => async () => {
      requests += 1;
      return fail ? new Response("offline", { status: 503 }) : Response.json(catalogFixture);
    },
  });

  const initial = await catalog.search({ query: "", page: 1, pageSize: 20 });
  now = new Date("2026-08-27T12:00:01.000Z");
  fail = true;
  const stale = await catalog.search({ query: "", page: 1, pageSize: 20 });

  assert.equal(requests, 2);
  assert.deepEqual(stale, initial);
  await assert.rejects(
    catalog.search({ query: "", page: 1, pageSize: 20, refresh: true }),
    /插件注册目录读取失败（HTTP 503）/u,
  );
});

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input.toString());
}
