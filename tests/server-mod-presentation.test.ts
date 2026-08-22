import assert from "node:assert/strict";
import test from "node:test";
import { Cmz_Markdown } from "cmzya-modern-ui";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import {
  serverModLoaderForCoreType,
  supportsUnifiedWorldStorage,
  type ServerInstanceSnapshot,
  type ServerModFilters,
  type ServerModSearchRequest,
  type ServerModSearchResult,
} from "../packages/contracts/src/index.ts";
import {
  compatibleServerModInstances,
  formatServerModDownloadCount,
  formatServerModRelativeTime,
  formatServerModVersionRange,
  groupServerModVersions,
  serverModDisplayName,
  serverModMcEncyclopediaSearchUrl,
  serverModDisplayTags,
} from "../frontend/server/download-mod/src/client/mod-presentation.ts";
import {
  createServerModMixedSearchState,
  groupServerModVersions as groupServerResourceVersions,
  mergeAvailableServerModFilters,
  searchServerModMixedPage,
  serverModProjectUrl,
  serverModSourceLabel,
} from "../frontend/server/download-resource-shared/src/resource-presentation.ts";

await test("mod display names append the stable English slug only for Chinese titles", () => {
  assert.deepEqual(serverModDisplayName({ title: "暮色森林", slug: "twilight-forest" }), {
    primary: "暮色森林",
    original: "Twilight Forest",
  });
  assert.deepEqual(serverModDisplayName({ title: "Lithium", slug: "lithium" }), {
    primary: "Lithium",
  });
  assert.deepEqual(serverModDisplayName({ title: "机械动力 | Create", slug: "create-fabric" }), {
    primary: "机械动力",
    original: "Create",
  });
});

await test("MC encyclopedia links use the dedicated search route and encoded plus separator", () => {
  assert.equal(
    serverModMcEncyclopediaSearchUrl("Fabric API"),
    "https://search.mcmod.cn/s?key=Fabric%2BAPI&mold=0",
  );
  assert.equal(
    serverModMcEncyclopediaSearchUrl("  Sodium   Extra  "),
    "https://search.mcmod.cn/s?key=Sodium%2BExtra&mold=0",
  );
});

await test("mod descriptions render Markdown while treating embedded HTML as text", async () => {
  const app = createSSRApp({
    render: () =>
      h(Cmz_Markdown, {
        content:
          "### FAQ\n\nRead [summary](https://github.com/example/project/blob/main/summary.md).\n\n<script>alert('unsafe')</script>",
        codeHighlight: false,
        features: { alert: false, linkCard: false, container: false },
      }),
  });
  const html = await renderToString(app);
  assert.match(html, /<h3>FAQ<\/h3>/u);
  assert.match(
    html,
    /<a href="https:\/\/github\.com\/example\/project\/blob\/main\/summary\.md">summary<\/a>/u,
  );
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /<p>&lt;script&gt;.*&lt;\/script&gt;<\/p>/u);
});

await test("mod display tags put libraries before content categories", () => {
  assert.deepEqual(
    serverModDisplayTags(
      ["fabric", "forge", "optimization", "library", "utility", "unknown"],
      [
        { id: "fabric", label: "Fabric" },
        { id: "forge", label: "Forge" },
      ],
      [
        { id: "library", label: "前置 / 库" },
        { id: "optimization", label: "性能优化" },
        { id: "utility", label: "实用工具" },
      ],
    ),
    {
      categories: ["Fabric", "Forge"],
      content: ["前置 / 库", "性能优化", "实用工具"],
    },
  );
});
await test("source labels expose the concrete catalog name", () => {
  assert.equal(serverModSourceLabel("modrinth"), "Modrinth");
  assert.equal(serverModSourceLabel("curseforge"), "CurseForge");
});

await test("project links keep the selected source and resource type", () => {
  assert.equal(
    serverModProjectUrl({ source: "curseforge", slug: "example-pack" }, "modpack"),
    "https://www.curseforge.com/minecraft/modpacks/example-pack",
  );
  assert.equal(
    serverModProjectUrl({ source: "curseforge", slug: "example-data-pack" }, "datapack"),
    "https://www.curseforge.com/minecraft/data-packs/example-data-pack",
  );
  assert.equal(
    serverModProjectUrl({ source: "modrinth", slug: "example-world" }, "world"),
    "https://modrinth.com/world/example-world",
  );
});

await test("partial source filter failures preserve available options", async () => {
  const failed = new Error("CurseForge 请求失败（HTTP 502）");
  const results = await Promise.allSettled([
    Promise.resolve<ServerModFilters>({
      sources: [],
      tags: [{ id: "utility", label: "实用工具" }],
      versions: [],
      loaders: [{ id: "fabric", label: "Fabric" }],
    }),
    Promise.reject<ServerModFilters>(failed),
  ]);
  const filters = mergeAvailableServerModFilters(results);
  assert.deepEqual(filters.tags, [{ id: "utility", label: "实用工具" }]);
  assert.deepEqual(filters.loaders, [{ id: "fabric", label: "Fabric" }]);
  assert.equal(filters.unavailableReason, "CurseForge 请求失败（HTTP 502）");
  assert.throws(() => mergeAvailableServerModFilters([results[1]!]), /HTTP 502/u);
});
await test("mod download counts use at most four digits without wrapping the unit", () => {
  assert.equal(formatServerModDownloadCount(9_999), "9999");
  assert.equal(formatServerModDownloadCount(10_000), "1万");
  assert.equal(formatServerModDownloadCount(1_234_000), "123.4万");
  assert.equal(formatServerModDownloadCount(61_164_000), "6116万");
  assert.equal(formatServerModDownloadCount(99_999_999), "1亿");
  assert.equal(formatServerModDownloadCount(1_234_000_000), "12.3亿");
});

await test("mod version labels collapse patch versions into exact supported ranges", () => {
  const knownVersions = ["1.21.4", "1.20.6", "1.19.4", "1.18.2", "1.17.1", "1.16.5"].map((id) => ({
    id,
    label: id,
  }));
  assert.equal(
    formatServerModVersionRange(
      ["1.16.5", "1.17.1", "1.18.2", "1.19.4", "1.20.6", "1.21.4"],
      knownVersions,
    ),
    "1.16+",
  );
  assert.equal(
    formatServerModVersionRange(["1.16.5", "1.17.1", "1.18.2", "1.19.4", "1.20.6"], knownVersions),
    "1.16–1.20",
  );
  assert.equal(
    formatServerModVersionRange(["1.16.5", "1.18.2", "1.21.4"], knownVersions),
    "1.16、1.18、1.21",
  );
  assert.equal(formatServerModVersionRange([], knownVersions), "版本未知");
});

await test("mod update times use hour, day, week, and month grains", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  assert.equal(formatServerModRelativeTime("2026-08-18T11:40:00Z", now), "1 小时前");
  assert.equal(formatServerModRelativeTime("2026-08-18T07:00:00Z", now), "5 小时前");
  assert.equal(formatServerModRelativeTime("2026-08-16T12:00:00Z", now), "2 天前");
  assert.equal(formatServerModRelativeTime("2026-08-04T12:00:00Z", now), "2 周前");
  assert.equal(formatServerModRelativeTime("2026-06-19T12:00:00Z", now), "2 个月前");
  assert.equal(formatServerModRelativeTime("invalid", now), "刚刚");
});

await test("mod versions group by loader and game version with newest files first", () => {
  const versions = [
    {
      id: "latest-fabric",
      gameVersions: ["1.21.1", "1.20.1"],
      loaders: ["fabric"],
      fileName: "fabric-latest.jar",
      downloads: 20,
      datePublished: "2026-08-18T12:00:00Z",
    },
    {
      id: "older-shared",
      gameVersions: ["1.21.1"],
      loaders: ["fabric", "forge"],
      fileName: "shared-older.jar",
      downloads: 10,
      datePublished: "2026-08-17T12:00:00Z",
    },
    {
      id: "forge-legacy",
      gameVersions: ["1.20.1"],
      loaders: ["forge"],
      fileName: "forge-legacy.jar",
      downloads: 5,
      datePublished: "2026-08-16T12:00:00Z",
    },
  ] as const;

  const groups = groupServerModVersions(versions);
  assert.deepEqual(
    groups.map(({ id, versions: groupVersions }) => [
      id,
      groupVersions.map(({ id: versionId }) => versionId),
    ]),
    [
      ["fabric:1.21.1", ["latest-fabric", "older-shared"]],
      ["forge:1.21.1", ["older-shared"]],
      ["fabric:1.20.1", ["latest-fabric"]],
      ["forge:1.20.1", ["forge-legacy"]],
    ],
  );
  assert.deepEqual(
    groupServerModVersions(versions, "1.20.1", "forge").map(({ id }) => id),
    ["forge:1.20.1"],
  );
});

await test("shared resource versions without loaders remain downloadable in a generic group", () => {
  const groups = groupServerResourceVersions([
    {
      id: "world-1",
      gameVersions: ["26.2"],
      loaders: [],
      fileName: "oneblock.zip",
      downloads: 1_000,
      datePublished: "2026-08-18T12:00:00Z",
    },
  ]);
  assert.deepEqual(
    groups.map(({ id, loader, gameVersion }) => ({ id, loader, gameVersion })),
    [{ id: ":26.2", loader: "", gameVersion: "26.2" }],
  );
});

await test("mixed source search keeps both sources across pages", async () => {
  const state = createServerModMixedSearchState();
  const projects = {
    modrinth: ["mr-1", "mr-2"],
    curseforge: ["cf-1", "cf-2"],
  } as const;
  const requests: string[] = [];
  const first = await searchServerModMixedPage(
    {
      resourceType: "mod",
      query: "",
      tag: "",
      index: "downloads",
      gameVersion: "",
      loader: "",
    },
    state,
    2,
    async (request) => {
      requests.push(`${request.source}:${request.offset}`);
      const ids = projects[request.source];
      const items = ids.slice(request.offset, request.offset + request.limit).map((id) => ({
        resourceType: "mod" as const,
        source: request.source,
        id,
        slug: id,
        title: id,
        description: "",
        author: "",
        downloads: 0,
        follows: 0,
        dateModified: "2026-08-18T12:00:00Z",
        environment: ["server_only"] as const,
        categories: [],
        versions: ["1.21.1"],
      }));
      return {
        items,
        offset: request.offset,
        limit: request.limit,
        total: ids.length,
      };
    },
  );
  const second = await searchServerModMixedPage(
    {
      resourceType: "mod",
      query: "",
      tag: "",
      index: "downloads",
      gameVersion: "",
      loader: "",
    },
    state,
    2,
    async () => {
      throw new Error("second page should use buffered results");
    },
  );
  assert.deepEqual(
    first.items.map(({ id }) => id),
    ["mr-1", "cf-1"],
  );
  assert.equal(first.offset, 0);
  assert.equal(first.limit, 2);
  assert.deepEqual(
    second.items.map(({ id }) => id),
    ["mr-2", "cf-2"],
  );
  assert.equal(first.total, 4);
  assert.equal(second.limit, 2);
  assert.equal(second.offset, 2);
  assert.deepEqual(requests, ["modrinth:0", "curseforge:0"]);
});

await test("mixed source pagination counts displayed items after a short first page", async () => {
  const state = createServerModMixedSearchState();
  const projects = {
    modrinth: ["mr-1"],
    curseforge: Array.from({ length: 45 }, (_, index) => `cf-${index + 1}`),
  };
  const requests: string[] = [];
  const requestBase = {
    resourceType: "mod" as const,
    query: "",
    tag: "",
    index: "downloads" as const,
    gameVersion: "",
    loader: "",
  };
  const search = async (request: ServerModSearchRequest): Promise<ServerModSearchResult> => {
    requests.push(`${request.source}:${request.offset}`);
    const ids = projects[request.source];
    const items = ids.slice(request.offset, request.offset + request.limit).map((id) => ({
      resourceType: "mod" as const,
      source: request.source,
      id,
      slug: id,
      title: id,
      description: "",
      author: "",
      downloads: 0,
      follows: 0,
      dateModified: "2026-08-18T12:00:00Z",
      environment: ["server_only"] as const,
      categories: [],
      versions: ["1.21.1"],
    }));
    return {
      items,
      offset: request.offset,
      limit: request.limit,
      total: ids.length,
    };
  };
  const pages = [];
  for (let page = 0; page < 3; page += 1) {
    pages.push(await searchServerModMixedPage(requestBase, state, 20, search));
  }

  assert.deepEqual(
    pages.map(({ offset }) => offset),
    [0, 20, 40],
  );
  assert.deepEqual(
    pages.map(({ limit }) => limit),
    [20, 20, 6],
  );
  assert.deepEqual(
    pages.flatMap(({ items }) => items.map(({ id }) => id)),
    ["mr-1", ...Array.from({ length: 45 }, (_, index) => `cf-${index + 1}`)],
  );
  assert.deepEqual(requests, ["modrinth:0", "curseforge:0", "curseforge:20", "curseforge:40"]);
});

await test("mixed source search clamps totals after a later source failure", async () => {
  const state = createServerModMixedSearchState();
  const projects = {
    modrinth: Array.from({ length: 45 }, (_, index) => `mr-${index + 1}`),
    curseforge: Array.from({ length: 20 }, (_, index) => `cf-${index + 1}`),
  };
  const requests: string[] = [];
  const requestBase = {
    resourceType: "mod" as const,
    query: "",
    tag: "",
    index: "downloads" as const,
    gameVersion: "",
    loader: "",
  };
  const search = async (request: ServerModSearchRequest): Promise<ServerModSearchResult> => {
    requests.push(`${request.source}:${request.offset}`);
    if (request.source === "curseforge" && request.offset >= 20) {
      throw new Error("CurseForge 请求频率已达上限，请稍后重试");
    }
    const ids = projects[request.source];
    const items = ids.slice(request.offset, request.offset + request.limit).map((id) => ({
      resourceType: "mod" as const,
      source: request.source,
      id,
      slug: id,
      title: id,
      description: "",
      author: "",
      downloads: 0,
      follows: 0,
      dateModified: "2026-08-18T12:00:00Z",
      environment: ["server_only"] as const,
      categories: [],
      versions: ["1.21.1"],
    }));
    return {
      items,
      offset: request.offset,
      limit: request.limit,
      total: request.source === "curseforge" ? 100 : ids.length,
    };
  };
  const pages = [];
  for (let page = 0; page < 4; page += 1) {
    pages.push(await searchServerModMixedPage(requestBase, state, 20, search));
  }
  const displayedIds = pages.flatMap(({ items }) => items.map(({ id }) => id));

  assert.deepEqual(
    pages.map(({ offset }) => offset),
    [0, 20, 40, 60],
  );
  assert.deepEqual(
    pages.map(({ limit }) => limit),
    [20, 20, 20, 5],
  );
  assert.deepEqual(
    pages.map(({ total }) => total),
    [145, 145, 65, 65],
  );
  assert.equal(pages[2]?.unavailableReason, "CurseForge 请求频率已达上限，请稍后重试");
  assert.equal(displayedIds.length, 65);
  assert.equal(new Set(displayedIds).size, 65);
  assert.deepEqual(requests, [
    "modrinth:0",
    "curseforge:0",
    "modrinth:20",
    "curseforge:20",
    "modrinth:40",
  ]);
});

await test("mixed source pagination clamps totals after malformed items are skipped", async () => {
  const state = createServerModMixedSearchState();
  const rawIds = ["mr-1", "bad-1", "mr-3", "bad-2", "mr-5", "bad-3"];
  const requestBase = {
    resourceType: "mod" as const,
    query: "",
    tag: "",
    index: "downloads" as const,
    gameVersion: "",
    loader: "",
  };
  const search = async (request: ServerModSearchRequest): Promise<ServerModSearchResult> => {
    if (request.source === "curseforge") {
      return {
        items: [],
        offset: request.offset,
        limit: request.limit,
        total: 0,
      };
    }
    const items = rawIds
      .slice(request.offset, request.offset + request.limit)
      .filter((id) => !id.startsWith("bad"))
      .map((id) => ({
        resourceType: "mod" as const,
        source: "modrinth" as const,
        id,
        slug: id,
        title: id,
        description: "",
        author: "",
        downloads: 0,
        follows: 0,
        dateModified: "2026-08-18T12:00:00Z",
        environment: ["server_only"] as const,
        categories: [],
        versions: ["1.21.1"],
      }));
    return {
      items,
      offset: request.offset,
      limit: request.limit,
      total: rawIds.length,
    };
  };
  const first = await searchServerModMixedPage(requestBase, state, 2, search);
  const second = await searchServerModMixedPage(requestBase, state, 2, search);

  assert.deepEqual(
    first.items.map(({ id }) => id),
    ["mr-1", "mr-3"],
  );
  assert.equal(first.offset, 0);
  assert.equal(first.limit, 2);
  assert.equal(first.total, 6);
  assert.deepEqual(
    second.items.map(({ id }) => id),
    ["mr-5"],
  );
  assert.equal(second.offset, 2);
  assert.equal(second.limit, 1);
  assert.equal(second.total, 3);
  assert.equal(second.offset + second.limit, second.total);
});

await test("mixed source search keeps Modrinth when CurseForge is unavailable", async () => {
  const state = createServerModMixedSearchState();
  const result = await searchServerModMixedPage(
    {
      resourceType: "mod",
      query: "",
      tag: "",
      index: "downloads",
      gameVersion: "",
      loader: "",
    },
    state,
    2,
    async (request) => {
      if (request.source === "curseforge") {
        throw new Error("CurseForge 请求失败（HTTP 502）");
      }
      return {
        items: [
          {
            resourceType: "mod" as const,
            source: "modrinth" as const,
            id: "mr-1",
            slug: "mr-1",
            title: "Modrinth project",
            description: "",
            author: "",
            downloads: 0,
            follows: 0,
            dateModified: "2026-08-18T00:00:00Z",
            environment: ["server_only"] as const,
            categories: [],
            versions: ["1.21.1"],
          },
        ],
        offset: request.offset,
        limit: 1,
        total: 1,
      };
    },
  );
  assert.deepEqual(
    result.items.map(({ id }) => id),
    ["mr-1"],
  );
  assert.equal(result.total, 1);
  assert.equal(state.finished.curseforge, true);
});

await test("server core types map to standard Mod loaders without treating plugin cores as Mod servers", () => {
  assert.equal(serverModLoaderForCoreType("arclight-fabric"), "fabric");
  assert.equal(serverModLoaderForCoreType("banner"), "fabric");
  assert.equal(serverModLoaderForCoreType("catserver"), "forge");
  assert.equal(serverModLoaderForCoreType("spongeforge"), "forge");
  assert.equal(serverModLoaderForCoreType("arclight-neoforge"), "neoforge");
  assert.equal(serverModLoaderForCoreType("youer"), "neoforge");
  assert.equal(serverModLoaderForCoreType("quilt"), "quilt");
  assert.equal(serverModLoaderForCoreType("paper"), null);
  assert.equal(serverModLoaderForCoreType("vanilla"), null);
});
await test("world downloads allow every verified vanilla-layout core and reject split/proxy cores", () => {
  const supported = [
    "vanilla",
    "vanilla-snapshot",
    "forge",
    "fabric",
    "quilt",
    "neoforge",
    "spongeforge",
    "spongevanilla",
    "paper",
    "purpur",
    "folia",
    "pufferfish",
    "pufferfish_purpur",
    "leaf",
    "leaves",
    "arclight-fabric",
    "arclight-forge",
    "arclight-neoforge",
    "banner",
    "mohist",
    "youer",
  ];
  const rejected = [
    "bukkit",
    "spigot",
    "catserver",
    "velocity",
    "bungeecord",
    "lightfall",
    "travertine",
    "nukkitx",
  ];
  assert.equal(new Set([...supported, ...rejected]).size, 29);
  for (const serverType of supported) assert.equal(supportsUnifiedWorldStorage(serverType), true);
  for (const serverType of rejected) assert.equal(supportsUnifiedWorldStorage(serverType), false);
});

await test("compatible Mod targets require both the exact loader and Minecraft version", () => {
  const base: ServerInstanceSnapshot = {
    id: "fabric-compatible",
    name: "Fabric compatible",
    rootPath: "C:/SeaShard/servers/fabric-compatible",
    coreJarPath: "C:/SeaShard/servers/fabric-compatible/server.jar",
    storageMode: "managed",
    source: "downloaded",
    modLoader: "fabric",
    serverType: "fabric",
    gameVersion: "1.21.1",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  const instances: ServerInstanceSnapshot[] = [
    base,
    { ...base, id: "forge", name: "Forge", modLoader: "forge", serverType: "mohist" },
    { ...base, id: "old-fabric", name: "Old Fabric", gameVersion: "1.20.1" },
    { ...base, id: "paper", name: "Paper", modLoader: null, serverType: "paper" },
  ];
  assert.deepEqual(
    compatibleServerModInstances(
      {
        id: "fabric-version",
        gameVersions: ["1.21.1"],
        loaders: ["fabric"],
        fileName: "server-tools.jar",
        downloads: 10,
        datePublished: "2026-08-20T00:00:00.000Z",
      },
      instances,
    ).map(({ id }) => id),
    ["fabric-compatible"],
  );
});
