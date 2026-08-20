import {
  serverModSearchLimits,
  type ServerModEnvironment,
  type ServerModFilterOption,
  type ServerModFilters,
  type ServerModProject,
  type ServerModSearchIndex,
  type ServerModSearchRequest,
  type ServerModSearchResult,
} from "@seashard/contracts";

export const defaultModrinthApiBaseUrl = "https://api.modrinth.com/v2/";

const serverEnvironments = [
  "client_and_server",
  "server_only",
  "server_only_client_optional",
  "dedicated_server_only",
  "client_or_server",
  "client_or_server_prefers_both",
] as const satisfies readonly ServerModEnvironment[];
const serverEnvironmentSet = new Set<string>(serverEnvironments);
const searchIndexes = new Set<ServerModSearchIndex>([
  "relevance",
  "downloads",
  "follows",
  "newest",
  "updated",
]);
const loaderNames = new Set([
  "babric",
  "bta-babric",
  "fabric",
  "forge",
  "java-agent",
  "legacy-fabric",
  "liteloader",
  "modloader",
  "neoforge",
  "nilloader",
  "ornithe",
  "quilt",
  "rift",
  "sponge",
]);
const loaderOrder = ["forge", "neoforge", "fabric", "quilt", "sponge"];
const filterIdPattern = /^[a-z0-9][a-z0-9+._-]{0,63}$/u;

const tagLabels: Readonly<Record<string, string>> = {
  adventure: "冒险",
  cursed: "趣味 / 魔改",
  decoration: "装饰",
  economy: "经济",
  equipment: "装备",
  food: "食物",
  "game-mechanics": "游戏机制",
  library: "前置 / 库",
  magic: "魔法",
  management: "管理",
  minigame: "小游戏",
  mobs: "生物",
  optimization: "性能优化",
  social: "社交",
  storage: "存储",
  technology: "科技",
  transportation: "交通",
  utility: "实用工具",
  worldgen: "世界生成",
};
const loaderLabels: Readonly<Record<string, string>> = {
  babric: "Babric",
  "bta-babric": "BTA Babric",
  fabric: "Fabric",
  forge: "Forge",
  "java-agent": "Java Agent",
  "legacy-fabric": "Legacy Fabric",
  liteloader: "LiteLoader",
  modloader: "ModLoader",
  neoforge: "NeoForge",
  nilloader: "NilLoader",
  ornithe: "Ornithe",
  quilt: "Quilt",
  rift: "Rift",
  sponge: "Sponge",
};

export interface ModrinthServerModCatalogOptions {
  readonly fetchProvider?: () => typeof globalThis.fetch;
  readonly userAgent: string;
  readonly baseUrl?: string;
}

/**
 * Modrinth 服务端 Mod 目录。
 *
 * Client 只能传入结构化筛选项；Facet 语句和目标 URL 均在 Host 内构造。筛选元数据按进程缓存，
 * 翻页只请求当前 20 条结果，避免滚动时重复拉取整份目录。
 */
export class ModrinthServerModCatalog {
  private readonly fetchProvider: () => typeof globalThis.fetch;
  private readonly userAgent: string;
  private readonly baseUrl: URL;
  private filtersPromise?: Promise<ServerModFilters>;

  constructor(options: ModrinthServerModCatalogOptions) {
    this.fetchProvider = options.fetchProvider ?? (() => globalThis.fetch);
    this.userAgent = options.userAgent.trim();
    if (!this.userAgent || this.userAgent.length > 256) {
      throw new TypeError("Modrinth User-Agent must be a non-empty string up to 256 characters");
    }
    this.baseUrl = new URL(options.baseUrl ?? defaultModrinthApiBaseUrl);
    if (this.baseUrl.protocol !== "https:") {
      throw new TypeError("Modrinth API base URL must use HTTPS");
    }
    this.baseUrl.pathname = `${this.baseUrl.pathname.replace(/\/+$/u, "")}/`;
    this.baseUrl.search = "";
    this.baseUrl.hash = "";
  }

  async getFilters(): Promise<ServerModFilters> {
    if (!this.filtersPromise) {
      const request = this.loadFilters();
      this.filtersPromise = request;
      void request.catch(() => {
        if (this.filtersPromise === request) this.filtersPromise = undefined;
      });
    }
    return this.filtersPromise;
  }

  async search(value: unknown): Promise<ServerModSearchResult> {
    const request = expectSearchRequest(value);
    const facets: string[][] = [
      ["project_type:mod"],
      serverEnvironments.map((environment) => `environment:${environment}`),
    ];
    if (request.tag) facets.push([`categories:${request.tag}`]);
    if (request.gameVersion) facets.push([`versions:${request.gameVersion}`]);
    if (request.loader) facets.push([`categories:${request.loader}`]);

    const url = this.endpoint("search");
    if (request.query) url.searchParams.set("query", request.query);
    url.searchParams.set("facets", JSON.stringify(facets));
    url.searchParams.set("index", request.index);
    url.searchParams.set("offset", String(request.offset));
    url.searchParams.set("limit", String(request.limit));

    return parseSearchResult(await this.fetchJson(url));
  }

  private async loadFilters(): Promise<ServerModFilters> {
    const [categories, versions, loaders] = await Promise.all([
      this.fetchJson(this.endpoint("tag/category")),
      this.fetchJson(this.endpoint("tag/game_version")),
      this.fetchJson(this.endpoint("tag/loader")),
    ]);
    return {
      sources: [{ id: "modrinth", label: "Modrinth" }],
      tags: parseTags(categories),
      versions: parseGameVersions(versions),
      loaders: parseLoaders(loaders),
    };
  }

  private endpoint(path: string): URL {
    return new URL(path, this.baseUrl);
  }

  private async fetchJson(url: URL): Promise<unknown> {
    const response = await this.fetchProvider()(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": this.userAgent,
      },
    });
    if (response.status === 429) {
      throw new Error("Modrinth 请求频率已达上限，请稍后重试");
    }
    if (!response.ok) {
      throw new Error(`Modrinth 请求失败（HTTP ${response.status}）`);
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new Error("Modrinth 返回了无效的 JSON 数据");
    }
  }
}

function expectSearchRequest(value: unknown): ServerModSearchRequest {
  const record = expectRecord(value, "Modrinth search request");
  const query = expectString(record.query, "query").trim();
  const tag = expectFilterId(record.tag, "tag");
  const gameVersion = expectFilterId(record.gameVersion, "game version");
  const loader = expectFilterId(record.loader, "loader");
  if (record.source !== "modrinth") {
    throw new TypeError("Modrinth search source must be modrinth");
  }
  if (query.length > serverModSearchLimits.maximumQueryLength || query.includes("\0")) {
    throw new TypeError("Modrinth search query is too long or contains NUL");
  }
  if (!searchIndexes.has(record.index as ServerModSearchIndex)) {
    throw new TypeError("Modrinth search index is invalid");
  }
  if (loader && !loaderNames.has(loader)) {
    throw new TypeError("Modrinth search loader is invalid");
  }
  if (!Number.isSafeInteger(record.offset) || (record.offset as number) < 0) {
    throw new TypeError("Modrinth search offset must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(record.limit) ||
    (record.limit as number) < 1 ||
    (record.limit as number) > serverModSearchLimits.maximumPageSize
  ) {
    throw new TypeError(
      `Modrinth search limit must be between 1 and ${serverModSearchLimits.maximumPageSize}`,
    );
  }
  return {
    source: "modrinth",
    query,
    tag,
    index: record.index as ServerModSearchIndex,
    gameVersion,
    loader,
    offset: record.offset as number,
    limit: record.limit as number,
  };
}

function parseTags(value: unknown): ServerModFilterOption[] {
  const options = expectArray(value, "Modrinth categories")
    .map((item, index) => expectRecord(item, `Modrinth category ${index}`))
    .filter((item) => item.project_type === "mod" && item.header === "categories")
    .map((item) => expectFilterId(item.name, "category name"))
    .filter(Boolean)
    .map((id) => ({ id, label: tagLabels[id] ?? formatIdentifier(id) }));
  return uniqueOptions(options).sort((left, right) =>
    left.label.localeCompare(right.label, "zh-CN"),
  );
}

function parseGameVersions(value: unknown): ServerModFilterOption[] {
  return uniqueOptions(
    expectArray(value, "Modrinth game versions")
      .map((item, index) => expectRecord(item, `Modrinth game version ${index}`))
      .filter((item) => item.version_type === "release")
      .map((item) => expectFilterId(item.version, "game version"))
      .filter(Boolean)
      .map((version) => ({ id: version, label: version })),
  );
}

function parseLoaders(value: unknown): ServerModFilterOption[] {
  const options = expectArray(value, "Modrinth loaders")
    .map((item, index) => expectRecord(item, `Modrinth loader ${index}`))
    .filter(
      (item) =>
        Array.isArray(item.supported_project_types) && item.supported_project_types.includes("mod"),
    )
    .map((item) => expectFilterId(item.name, "loader name"))
    .filter((name) => loaderNames.has(name))
    .map((id) => ({ id, label: loaderLabels[id] ?? formatIdentifier(id) }));
  return uniqueOptions(options).sort((left, right) => {
    const leftPriority = loaderOrder.indexOf(left.id);
    const rightPriority = loaderOrder.indexOf(right.id);
    if (leftPriority >= 0 || rightPriority >= 0) {
      if (leftPriority < 0) return 1;
      if (rightPriority < 0) return -1;
      return leftPriority - rightPriority;
    }
    return left.label.localeCompare(right.label, "en");
  });
}

function parseSearchResult(value: unknown): ServerModSearchResult {
  const record = expectRecord(value, "Modrinth search result");
  const hits = expectArray(record.hits, "Modrinth search hits");
  const offset = expectNonNegativeInteger(record.offset, "Modrinth result offset");
  const limit = expectNonNegativeInteger(record.limit, "Modrinth result limit");
  const total = expectNonNegativeInteger(record.total_hits, "Modrinth result total");
  if (limit > serverModSearchLimits.maximumPageSize || hits.length > limit) {
    throw new Error("Modrinth search returned an oversized page");
  }
  return {
    items: hits.map(parseProject),
    offset,
    limit,
    total,
  };
}

function parseProject(value: unknown, index: number): ServerModProject {
  const record = expectRecord(value, `Modrinth project ${index}`);
  if (record.project_type !== "mod") {
    throw new Error(`Modrinth project ${index} is not a mod`);
  }
  const environment = parseStringArray(
    record.environment,
    `Modrinth project ${index} environment`,
    16,
  ).filter((item): item is ServerModEnvironment => serverEnvironmentSet.has(item));
  if (environment.length === 0) {
    throw new Error(`Modrinth project ${index} has no server-compatible environment`);
  }
  const dateModified = expectBoundedString(
    record.date_modified,
    `Modrinth project ${index} modified date`,
    64,
  );
  if (Number.isNaN(Date.parse(dateModified))) {
    throw new Error(`Modrinth project ${index} has an invalid modified date`);
  }
  const id = expectBoundedString(record.project_id, `Modrinth project ${index} id`, 64);
  const iconUrl = expectProjectIconUrl(record.icon_url, id, index);
  return {
    source: "modrinth",
    id,
    slug: expectBoundedString(record.slug, `Modrinth project ${index} slug`, 128),
    title: expectBoundedString(record.title, `Modrinth project ${index} title`, 200),
    ...(iconUrl ? { iconUrl } : {}),
    description: expectBoundedString(
      record.description,
      `Modrinth project ${index} description`,
      1_000,
      true,
    ),
    author: expectBoundedString(record.author, `Modrinth project ${index} author`, 200),
    downloads: expectNonNegativeInteger(record.downloads, `Modrinth project ${index} downloads`),
    follows: expectNonNegativeInteger(record.follows, `Modrinth project ${index} follows`),
    dateModified,
    environment,
    categories: parseStringArray(record.categories, `Modrinth project ${index} categories`, 64),
    versions: parseStringArray(record.versions, `Modrinth project ${index} versions`, 512),
  };
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function expectFilterId(value: unknown, label: string): string {
  const id = expectString(value, label).trim();
  if (id && !filterIdPattern.test(id)) throw new TypeError(`${label} is invalid`);
  return id;
}

function expectBoundedString(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  const result = expectString(value, label);
  if ((!allowEmpty && !result) || result.length > maximumLength || result.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return result;
}

function expectProjectIconUrl(
  value: unknown,
  projectId: string,
  index: number,
): string | undefined {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim().length === 0)
  ) {
    return undefined;
  }
  const source = expectBoundedString(value, `Modrinth project ${index} icon URL`, 2_048);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`Modrinth project ${index} icon URL is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "cdn.modrinth.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(`/data/${encodeURIComponent(projectId)}/`)
  ) {
    throw new Error(`Modrinth project ${index} icon URL is outside the trusted CDN path`);
  }
  return url.href;
}

function expectNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseStringArray(value: unknown, label: string, maximumItems: number): string[] {
  const items = expectArray(value, label);
  if (items.length > maximumItems) throw new Error(`${label} contains too many items`);
  return [...new Set(items.map((item) => expectBoundedString(item, label, 128)))];
}

function uniqueOptions(options: readonly ServerModFilterOption[]): ServerModFilterOption[] {
  const seen = new Set<string>();
  return options.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function formatIdentifier(value: string): string {
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
