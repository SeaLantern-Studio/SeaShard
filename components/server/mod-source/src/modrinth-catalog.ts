import type { ServerModCatalogImplementation } from "./catalog-types";
import {
  serverModSearchLimits,
  type ServerModEnvironment,
  type ServerModFilterOption,
  type ServerModFilters,
  type ServerModProject,
  type ServerModProjectDetails,
  type ServerModSearchIndex,
  type ServerModSearchRequest,
  type ServerModSearchResult,
  type ServerModDownloadableResourceType,
  type ServerModrinthResourceType,
  type ServerModVersion,
} from "@seashard/contracts";

import type { ServerModArtifact } from "./catalog-types";
export const defaultModrinthApiBaseUrl = "https://api.modrinth.com/v2/";
/** MCIM 只作为官方 Modrinth API 失败后的备用元数据源。 */
export const defaultMcimModrinthApiBaseUrl = "https://mod.mcimirror.top/modrinth/v2/";
/** MCIM 文件 CDN 与 Modrinth CDN 使用相同的路径结构。 */
export const defaultMcimModrinthFileBaseUrl = "https://mod.mcimirror.top/";

const serverEnvironments = [
  "client_and_server",
  "server_only",
  "server_only_client_optional",
  "dedicated_server_only",
  "client_or_server",
  "client_or_server_prefers_both",
] as const satisfies readonly ServerModEnvironment[];
const resourceTypes = new Set<ServerModrinthResourceType>(["mod", "modpack", "datapack", "world"]);
const serverEnvironmentSet = new Set<string>(serverEnvironments);
const knownEnvironmentSet = new Set<string>([
  ...serverEnvironments,
  "client_only_server_optional",
  "client_only",
]);
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
const projectIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

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
  readonly fallbackBaseUrl?: string;
  readonly fallbackFileBaseUrl?: string;
}

export type ModrinthServerModArtifact = ServerModArtifact;

/**
 * Modrinth 服务端资源目录。
 *
 * Client 只能传入结构化筛选项；Facet 语句和目标 URL 均在 Host 内构造。筛选元数据按资源类型
 * 和进程缓存，翻页只请求当前 20 条结果，避免滚动时重复拉取整份目录。
 */
export class ModrinthServerModCatalog implements ServerModCatalogImplementation {
  private readonly fetchProvider: () => typeof globalThis.fetch;
  private readonly userAgent: string;
  private readonly baseUrl: URL;
  private readonly fallbackBaseUrl?: URL;
  private readonly fallbackFileBaseUrl?: URL;
  private readonly filtersPromises = new Map<
    ServerModrinthResourceType,
    Promise<ServerModFilters>
  >();
  constructor(options: ModrinthServerModCatalogOptions) {
    this.fetchProvider = options.fetchProvider ?? (() => globalThis.fetch);
    this.userAgent = options.userAgent.trim();
    if (!this.userAgent || this.userAgent.length > 256) {
      throw new TypeError("Modrinth User-Agent must be a non-empty string up to 256 characters");
    }
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? defaultModrinthApiBaseUrl,
      "Modrinth API base URL",
    );
    this.fallbackBaseUrl = options.fallbackBaseUrl
      ? normalizeBaseUrl(options.fallbackBaseUrl, "Modrinth fallback API base URL")
      : undefined;
    this.fallbackFileBaseUrl = options.fallbackFileBaseUrl
      ? normalizeBaseUrl(options.fallbackFileBaseUrl, "Modrinth fallback file base URL")
      : undefined;
  }

  async getFilters(resourceTypeValue: unknown): Promise<ServerModFilters> {
    const resourceType = expectResourceType(resourceTypeValue);
    const cached = this.filtersPromises.get(resourceType);
    if (cached) return cached;

    const request = this.loadFilters(resourceType);
    this.filtersPromises.set(resourceType, request);
    void request.catch(() => {
      if (this.filtersPromises.get(resourceType) === request) {
        this.filtersPromises.delete(resourceType);
      }
    });
    return request;
  }

  async search(value: unknown): Promise<ServerModSearchResult> {
    const request = expectSearchRequest(value);
    const facets: string[][] = [
      [
        request.resourceType === "mod"
          ? "project_type:mod"
          : `all_project_types:${request.resourceType}`,
      ],
    ];
    if (request.resourceType === "mod") {
      facets.push(serverEnvironments.map((environment) => `environment:${environment}`));
    }
    if (request.tag) facets.push([`categories:${request.tag}`]);
    if (request.gameVersion) facets.push([`versions:${request.gameVersion}`]);
    if (request.loader) facets.push([`categories:${request.loader}`]);

    return this.fetchFromSources(
      (baseUrl) => {
        const url = this.endpoint("search", baseUrl);
        if (request.query) url.searchParams.set("query", request.query);
        url.searchParams.set("facets", JSON.stringify(facets));
        url.searchParams.set("index", request.index);
        url.searchParams.set("offset", String(request.offset));
        url.searchParams.set("limit", String(request.limit));
        return url;
      },
      (value) => parseSearchResult(value, request.resourceType, request.offset),
    );
  }

  async getProjectDetails(
    resourceTypeValue: unknown,
    projectValue: unknown,
  ): Promise<ServerModProjectDetails> {
    const resourceType = expectResourceType(resourceTypeValue);
    const projectId = expectProjectId(projectValue);
    const projectPath = `project/${encodeURIComponent(projectId)}`;
    return this.fetchGroupFromSources(
      async (baseUrl) => {
        const versionsUrl = this.endpoint(`${projectPath}/version`, baseUrl);
        versionsUrl.searchParams.set("include_changelog", "false");
        return Promise.all([
          this.fetchJson(this.endpoint(projectPath, baseUrl)),
          this.fetchJson(versionsUrl),
        ]);
      },
      ([project, versions]) => parseProjectDetails(project, versions, projectId, resourceType),
    );
  }

  /** 按稳定版本 ID 重新读取下载元数据，避免信任 Renderer 缓存的 URL 或哈希。 */
  async resolveVersionArtifact(
    resourceTypeValue: unknown,
    projectValue: unknown,
    versionValue: unknown,
  ): Promise<ModrinthServerModArtifact> {
    const resourceType = expectDownloadableResourceType(resourceTypeValue);
    const projectId = expectProjectId(projectValue);
    const versionId = expectVersionId(versionValue);
    return this.fetchGroupFromSources(
      (baseUrl) =>
        Promise.all([
          this.fetchJson(this.endpoint(`project/${encodeURIComponent(projectId)}`, baseUrl)),
          this.fetchJson(this.endpoint(`version/${encodeURIComponent(versionId)}`, baseUrl)),
        ]),
      ([project, version]) =>
        parseVersionArtifact(
          project,
          version,
          resourceType,
          projectId,
          versionId,
          this.fallbackFileBaseUrl,
        ),
    );
  }

  private async loadFilters(resourceType: ServerModrinthResourceType): Promise<ServerModFilters> {
    const [categories, versions, loaders] = await Promise.all([
      this.fetchFromSources(
        (baseUrl) => this.endpoint("tag/category", baseUrl),
        (value) => value,
      ),
      this.fetchFromSources(
        (baseUrl) => this.endpoint("tag/game_version", baseUrl),
        (value) => value,
      ),
      this.fetchFromSources(
        (baseUrl) => this.endpoint("tag/loader", baseUrl),
        (value) => value,
      ),
    ]);
    return {
      sources: [{ id: "modrinth", label: "Modrinth" }],
      tags: parseTags(categories, resourceType),
      versions: parseGameVersions(versions),
      loaders: parseLoaders(loaders, resourceType),
    };
  }

  private endpoint(path: string, baseUrl = this.baseUrl): URL {
    return new URL(path, baseUrl);
  }

  private async fetchFromSources<T>(
    createUrl: (baseUrl: URL) => URL,
    parse: (value: unknown) => T,
  ): Promise<T> {
    let lastError: unknown;
    for (const baseUrl of this.sourceUrls()) {
      try {
        return parse(await this.fetchJson(createUrl(baseUrl)));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Modrinth source request failed");
  }

  private sourceUrls(): readonly URL[] {
    return this.fallbackBaseUrl ? [this.baseUrl, this.fallbackBaseUrl] : [this.baseUrl];
  }

  private async fetchGroupFromSources<TValue, T>(
    fetchGroup: (baseUrl: URL) => Promise<TValue>,
    parse: (value: TValue) => T,
  ): Promise<T> {
    let lastError: unknown;
    for (const baseUrl of this.sourceUrls()) {
      try {
        return parse(await fetchGroup(baseUrl));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Modrinth source request failed");
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

function normalizeBaseUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new TypeError(`${label} must use HTTPS`);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  url.search = "";
  url.hash = "";
  return url;
}

function expectSearchRequest(value: unknown): ServerModSearchRequest {
  const record = expectRecord(value, "Modrinth search request");
  const resourceType = expectResourceType(record.resourceType);
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
  if (loader && (!loaderNames.has(loader) || resourceType === "datapack")) {
    throw new TypeError("Modrinth search loader is invalid for this resource type");
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
    resourceType,
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

function expectResourceType(value: unknown): ServerModrinthResourceType {
  if (typeof value !== "string" || !resourceTypes.has(value as ServerModrinthResourceType)) {
    throw new TypeError("Modrinth resource type is invalid");
  }
  return value as ServerModrinthResourceType;
}

function expectDownloadableResourceType(value: unknown): "mod" | "modpack" | "datapack" | "world" {
  return expectResourceType(value);
}

function expectProjectId(value: unknown): string {
  const projectId = expectString(value, "Modrinth project ID").trim();
  if (!projectIdPattern.test(projectId)) {
    throw new TypeError("Modrinth project ID is invalid");
  }
  return projectId;
}

function expectVersionId(value: unknown): string {
  const versionId = expectString(value, "Modrinth version ID").trim();
  if (!projectIdPattern.test(versionId)) {
    throw new TypeError("Modrinth version ID is invalid");
  }
  return versionId;
}

function parseTags(
  value: unknown,
  resourceType: ServerModrinthResourceType,
): ServerModFilterOption[] {
  // Modrinth 的数据包沿用 Mod 项目类别；筛选身份则通过 all_project_types:datapack 保证。
  const categoryProjectType = resourceType === "datapack" ? "mod" : resourceType;
  const options = expectArray(value, "Modrinth categories")
    .map((item, index) => expectRecord(item, `Modrinth category ${index}`))
    .filter((item) => item.project_type === categoryProjectType && item.header === "categories")
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

function parseLoaders(
  value: unknown,
  resourceType: ServerModrinthResourceType,
): ServerModFilterOption[] {
  if (resourceType === "datapack") return [];
  const options = expectArray(value, "Modrinth loaders")
    .map((item, index) => expectRecord(item, `Modrinth loader ${index}`))
    .filter(
      (item) =>
        Array.isArray(item.supported_project_types) &&
        item.supported_project_types.includes(resourceType),
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
function parseSearchResult(
  value: unknown,
  resourceType: ServerModrinthResourceType,
  expectedOffset: number,
): ServerModSearchResult {
  const record = expectRecord(value, "Modrinth search result");
  const hits = expectArray(record.hits, "Modrinth search hits");
  const offset = expectNonNegativeInteger(record.offset, "Modrinth result offset");
  const limit = expectNonNegativeInteger(record.limit, "Modrinth result limit");
  const total = expectNonNegativeInteger(record.total_hits, "Modrinth result total");
  if (offset !== expectedOffset) {
    throw new Error(`Modrinth search returned offset ${offset}, expected ${expectedOffset}`);
  }
  if (limit < 1 || limit > serverModSearchLimits.maximumPageSize || hits.length > limit) {
    throw new Error("Modrinth search returned an oversized page");
  }
  const items = hits.flatMap((project, index) => {
    try {
      return [parseProject(project, index, resourceType)];
    } catch {
      // 上游单条项目数据偶尔不完整；跳过坏条目，不能让整页结果失效。
      return [];
    }
  });
  return {
    items,
    offset,
    limit,
    total,
  };
}

function parseProject(
  value: unknown,
  index: number,
  resourceType: ServerModrinthResourceType,
): ServerModProject {
  const record = expectRecord(value, `Modrinth project ${index}`);
  if (!matchesSearchResourceType(record, resourceType)) {
    throw new Error(`Modrinth project ${index} does not match ${resourceType}`);
  }
  const environment = parseProjectEnvironment(
    record.environment,
    `Modrinth project ${index} environment`,
    resourceType,
  );
  if (resourceType === "mod" && !environment.some((item) => serverEnvironmentSet.has(item))) {
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
    resourceType,
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

function matchesSearchResourceType(
  project: Record<string, unknown>,
  resourceType: ServerModrinthResourceType,
): boolean {
  if (resourceType !== "datapack") return project.project_type === resourceType;
  return (
    project.project_type === "datapack" ||
    (Array.isArray(project.all_project_types) && project.all_project_types.includes("datapack"))
  );
}

function parseProjectEnvironment(
  value: unknown,
  label: string,
  resourceType: ServerModrinthResourceType,
): ServerModEnvironment[] {
  // Datapack 的运行位置天然是服务端；Modrinth 部分数据包项目没有可用 environment。
  // 统一投影为 server_only，避免合法数据包在 IPC 合约校验处被误判为坏项目。
  if (resourceType === "datapack" && value === undefined) return ["server_only"];
  const environment = parseStringArray(value, label, 16).filter(
    (item): item is ServerModEnvironment => knownEnvironmentSet.has(item),
  );
  return resourceType === "datapack" && environment.length === 0 ? ["server_only"] : environment;
}
function parseProjectDetails(
  projectValue: unknown,
  versionsValue: unknown,
  expectedProjectId: string,
  resourceType: ServerModrinthResourceType,
): ServerModProjectDetails {
  const project = expectRecord(projectValue, "Modrinth project details");
  const projectId = expectBoundedString(project.id, "Modrinth project details ID", 64);
  if (projectId !== expectedProjectId || !matchesDetailResourceType(project, resourceType)) {
    throw new Error(`Modrinth project details do not match the requested ${resourceType}`);
  }
  const versions = expectArray(versionsValue, "Modrinth project versions");
  if (versions.length > 2_048) {
    throw new Error("Modrinth project returned too many versions");
  }
  const parsedProject = parseModrinthDetailsProject(project, projectId, resourceType);
  return {
    resourceType,
    source: "modrinth",
    projectId,
    project: parsedProject,
    body: expectBoundedString(project.body, "Modrinth project body", 200_000, true),
    versions: versions
      .map((value, index) => parseProjectVersion(value, index, projectId))
      .filter((version) => matchesResourceVersion(version, resourceType)),
  };
}

function parseModrinthDetailsProject(
  project: Record<string, unknown>,
  projectId: string,
  resourceType: ServerModrinthResourceType,
): ServerModProject {
  const iconUrl = expectProjectIconUrl(project.icon_url, projectId, 0);
  const dateModified = expectBoundedString(
    project.updated,
    "Modrinth project details modified date",
    64,
  );
  if (Number.isNaN(Date.parse(dateModified))) {
    throw new Error("Modrinth project details modified date is invalid");
  }
  const environment = parseDetailProjectEnvironment(project, resourceType);
  return {
    resourceType,
    source: "modrinth",
    id: projectId,
    slug: expectBoundedString(project.slug, "Modrinth project details slug", 128),
    title: expectBoundedString(project.title, "Modrinth project details title", 200),
    ...(iconUrl ? { iconUrl } : {}),
    description: expectBoundedString(
      project.description,
      "Modrinth project details description",
      1_000,
      true,
    ),
    author: expectBoundedString(project.team, "Modrinth project details team", 200),
    downloads: expectNonNegativeInteger(project.downloads, "Modrinth project details downloads"),
    follows: expectNonNegativeInteger(project.followers, "Modrinth project details followers"),
    dateModified,
    environment,
    categories: parseStringArray(project.categories, "Modrinth project details categories", 64),
    versions: parseStringArray(
      project.game_versions,
      "Modrinth project details game versions",
      512,
    ),
  };
}

function parseDetailProjectEnvironment(
  project: Record<string, unknown>,
  resourceType: ServerModrinthResourceType,
): ServerModEnvironment[] {
  if (resourceType !== "mod") return ["server_only"];
  const clientSide = String(project.client_side);
  const serverSide = String(project.server_side);
  if (serverSide === "required") {
    return clientSide === "required" ? ["client_and_server"] : ["server_only_client_optional"];
  }
  if (clientSide === "required") return ["client_only_server_optional"];
  return ["client_or_server"];
}

function parseProjectVersion(value: unknown, index: number, projectId: string): ServerModVersion {
  const record = expectRecord(value, `Modrinth project version ${index}`);
  if (record.project_id !== projectId) {
    throw new Error(`Modrinth project version ${index} belongs to another project`);
  }
  const datePublished = expectBoundedString(
    record.date_published,
    `Modrinth project version ${index} published date`,
    64,
  );
  if (Number.isNaN(Date.parse(datePublished))) {
    throw new Error(`Modrinth project version ${index} has an invalid published date`);
  }
  const files = expectArray(record.files, `Modrinth project version ${index} files`);
  if (files.length === 0 || files.length > 64) {
    throw new Error(`Modrinth project version ${index} has invalid files`);
  }
  const parsedFiles = files.map((file, fileIndex) => {
    const fileRecord = expectRecord(file, `Modrinth project version ${index} file ${fileIndex}`);
    if (typeof fileRecord.primary !== "boolean") {
      throw new Error(`Modrinth project version ${index} file ${fileIndex} is invalid`);
    }
    return {
      fileName: expectBoundedString(
        fileRecord.filename,
        `Modrinth project version ${index} file ${fileIndex} name`,
        512,
      ),
      primary: fileRecord.primary,
    };
  });
  const primaryFile = parsedFiles.find(({ primary }) => primary) ?? parsedFiles[0]!;
  return {
    id: expectBoundedString(record.id, `Modrinth project version ${index} ID`, 64),
    gameVersions: parseStringArray(
      record.game_versions,
      `Modrinth project version ${index} game versions`,
      512,
    ),
    loaders: parseStringArray(record.loaders, `Modrinth project version ${index} loaders`, 64),
    fileName: primaryFile.fileName,
    downloads: expectNonNegativeInteger(
      record.downloads,
      `Modrinth project version ${index} downloads`,
    ),
    datePublished,
  };
}

function parseVersionArtifact(
  projectValue: unknown,
  versionValue: unknown,
  resourceType: ServerModDownloadableResourceType,
  projectId: string,
  versionId: string,
  fallbackFileBaseUrl?: URL,
): ModrinthServerModArtifact {
  const project = expectRecord(projectValue, "Modrinth download project");
  if (project.id !== projectId || !matchesDetailResourceType(project, resourceType)) {
    throw new Error(`Modrinth project does not match the requested ${resourceType}`);
  }
  if (
    resourceType === "mod" &&
    !["required", "optional", "unknown"].includes(String(project.server_side))
  ) {
    throw new Error("Modrinth project is not compatible with dedicated servers");
  }
  const iconUrl = expectProjectIconUrl(project.icon_url, projectId, 0);

  const version = expectRecord(versionValue, "Modrinth download version");
  if (version.id !== versionId || version.project_id !== projectId) {
    throw new Error("Modrinth version does not belong to the requested project");
  }
  const gameVersions = parseStringArray(
    version.game_versions,
    "Modrinth download game versions",
    512,
  );
  const loaders = parseStringArray(version.loaders, "Modrinth download loaders", 64);
  if (resourceType === "datapack" && !loaders.includes("datapack")) {
    throw new Error("Modrinth version is not a datapack");
  }
  const files = expectArray(version.files, "Modrinth download version files");
  if (files.length === 0 || files.length > 64) {
    throw new Error("Modrinth download version has invalid files");
  }
  const fileRecords = files.map((value, index) => {
    const file = expectRecord(value, `Modrinth download file ${index}`);
    if (typeof file.primary !== "boolean") {
      throw new Error(`Modrinth download file ${index} is invalid`);
    }
    return file;
  });
  const file = fileRecords.find(({ primary }) => primary) ?? fileRecords[0]!;
  const fileName = expectResourceFileName(file.filename, resourceType);
  const hashes = expectRecord(file.hashes, "Modrinth download file hashes");
  const sha512 = expectBoundedString(hashes.sha512, "Modrinth download SHA-512", 128).toLowerCase();
  if (!/^[a-f0-9]{128}$/u.test(sha512)) {
    throw new Error("Modrinth download SHA-512 is invalid");
  }
  const url = expectModFileUrl(file.url, projectId, fileName);
  return {
    source: "modrinth",
    resourceType,
    projectId,
    ...(iconUrl ? { iconUrl } : {}),
    versionId,
    fileName,
    url,
    ...(fallbackFileBaseUrl ? { fallbackUrl: toFallbackModFileUrl(url, fallbackFileBaseUrl) } : {}),
    sha512,
    size: expectNonNegativeInteger(file.size, "Modrinth download file size"),
    gameVersions,
    loaders,
  };
}
function matchesDetailResourceType(
  project: Record<string, unknown>,
  resourceType: ServerModrinthResourceType,
): boolean {
  if (resourceType !== "datapack") return project.project_type === resourceType;
  return (
    project.project_type === "datapack" ||
    (Array.isArray(project.loaders) && project.loaders.includes("datapack"))
  );
}

function matchesResourceVersion(
  version: ServerModVersion,
  resourceType: ServerModrinthResourceType,
): boolean {
  const fileName = version.fileName.toLowerCase();
  if (resourceType === "modpack") return fileName.endsWith(".mrpack");
  if (resourceType === "datapack" || resourceType === "world") {
    return fileName.endsWith(".zip");
  }
  return !version.loaders.includes("datapack") && fileName.endsWith(".jar");
}

function expectResourceFileName(
  value: unknown,
  resourceType: "mod" | "modpack" | "datapack" | "world",
): string {
  const fileName = expectBoundedString(value, "Modrinth download file name", 512);
  const lower = fileName.toLowerCase();
  const validExtension =
    resourceType === "mod"
      ? lower.endsWith(".jar")
      : lower.endsWith(".zip") || (resourceType === "modpack" && lower.endsWith(".mrpack"));
  if (
    !validExtension ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    throw new Error(`Modrinth ${resourceType} download file name is invalid`);
  }
  return fileName;
}

function expectModFileUrl(value: unknown, projectId: string, fileName: string): string {
  const source = expectBoundedString(value, "Modrinth download file URL", 2_048);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("Modrinth download file URL is invalid");
  }
  let finalSegment: string;
  try {
    finalSegment = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
  } catch {
    throw new Error("Modrinth download file URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "cdn.modrinth.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(`/data/${encodeURIComponent(projectId)}/versions/`) ||
    finalSegment !== fileName
  ) {
    throw new Error("Modrinth download file URL is outside the trusted CDN path");
  }
  return url.href;
}

function toFallbackModFileUrl(source: string, fallbackBaseUrl: URL): string | undefined {
  const sourceUrl = new URL(source);
  if (sourceUrl.hostname !== "cdn.modrinth.com") return undefined;
  return new URL(sourceUrl.pathname.slice(1), fallbackBaseUrl).href;
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
