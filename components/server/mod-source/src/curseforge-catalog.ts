import {
  type ServerModFilters,
  type ServerModProject,
  type ServerModProjectDetails,
  type ServerModSearchRequest,
  type ServerModSearchResult,
  type ServerModVersion,
  type ServerModrinthResourceType,
} from "@seashard/contracts";
import type { ServerModArtifact, ServerModCatalogImplementation } from "./catalog-types";

/** MCIM 的 CurseForge 兼容 API；不在桌面端保存官方 CurseForge API Key。 */
export const curseForgeMinecraftGameId = 432;
/** MCIM 提供的 CurseForge 兼容接口；分类 ID 与官方 CurseForge API 保持一致。 */
export const defaultMcimCurseForgeApiBaseUrl = "https://mod.mcimirror.top/curseforge/v1/";
export const curseForgeMinecraftClassIds: Readonly<Record<ServerModrinthResourceType, number>> = {
  mod: 6,
  modpack: 4471,
  datapack: 694,
  world: 17,
};
export const curseForgeMinecraftModClassId = curseForgeMinecraftClassIds.mod;

const loaderIds = new Map([
  ["forge", 1],
  ["fabric", 4],
  ["quilt", 5],
  ["neoforge", 6],
]);
const loaderLabels: Readonly<Record<string, string>> = {
  forge: "Forge",
  fabric: "Fabric",
  quilt: "Quilt",
  neoforge: "NeoForge",
};
const loaderNames = new Set(loaderIds.keys());
const nonVersionLabels = new Set([
  "client",
  "server",
  "fabric",
  "forge",
  "neoforge",
  "quilt",
  "liteloader",
  "rift",
]);

const curseForgeUnavailableReason = "CurseForge 暂时不可用，请稍后重试";

class CurseForgeTransientError extends Error {
  constructor() {
    super(curseForgeUnavailableReason);
    this.name = "CurseForgeTransientError";
  }
}

export interface CurseForgeServerModCatalogOptions {
  readonly fetchProvider?: () => typeof globalThis.fetch;
  readonly userAgent: string;
  readonly baseUrl?: string;
}

export class CurseForgeServerModCatalog implements ServerModCatalogImplementation {
  private readonly fetchProvider: () => typeof globalThis.fetch;
  private readonly userAgent: string;
  private readonly baseUrl: URL;
  private readonly filtersPromises = new Map<
    ServerModrinthResourceType,
    Promise<ServerModFilters>
  >();
  constructor(options: CurseForgeServerModCatalogOptions) {
    this.fetchProvider = options.fetchProvider ?? (() => globalThis.fetch);
    this.userAgent = options.userAgent.trim();
    if (!this.userAgent || this.userAgent.length > 256) {
      throw new TypeError("CurseForge User-Agent must be a non-empty string up to 256 characters");
    }
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? defaultMcimCurseForgeApiBaseUrl,
      "CurseForge API base URL",
    );
  }

  async getFilters(resourceType: ServerModrinthResourceType): Promise<ServerModFilters> {
    const cached = this.filtersPromises.get(resourceType);
    if (cached) return cached;
    const request = this.loadFilters(resourceType).catch((error) => {
      if (!(error instanceof CurseForgeTransientError)) throw error;
      if (this.filtersPromises.get(resourceType) === request) {
        this.filtersPromises.delete(resourceType);
      }
      return unavailableFilters();
    });
    this.filtersPromises.set(resourceType, request);
    void request.catch(() => {
      if (this.filtersPromises.get(resourceType) === request)
        this.filtersPromises.delete(resourceType);
    });
    return request;
  }

  async search(request: ServerModSearchRequest): Promise<ServerModSearchResult> {
    const url = this.endpoint("mods/search");
    url.searchParams.set("gameId", String(curseForgeMinecraftGameId));
    url.searchParams.set("classId", String(classIdFor(request.resourceType)));
    url.searchParams.set("index", String(request.offset));
    url.searchParams.set("pageSize", String(request.limit));
    if (request.query) url.searchParams.set("searchFilter", request.query);
    if (request.tag) url.searchParams.set("categoryId", expectCategoryId(request.tag));
    if (request.gameVersion) url.searchParams.set("gameVersion", request.gameVersion);
    if (request.loader) {
      const loaderId = loaderIds.get(request.loader);
      if (!loaderId) throw new TypeError("CurseForge search loader is invalid");
      url.searchParams.set("modLoaderType", String(loaderId));
    }
    const sort = sortFor(request.index);
    url.searchParams.set("sortField", sort.field);
    url.searchParams.set("sortOrder", sort.order);
    try {
      return parseSearchResult(
        await this.fetchJson(url),
        request.resourceType,
        request.offset,
        request.limit,
      );
    } catch (error) {
      if (!(error instanceof CurseForgeTransientError)) throw error;
      return unavailableSearchResult(request);
    }
  }

  async getProjectDetails(
    resourceType: ServerModrinthResourceType,
    projectValue: unknown,
  ): Promise<ServerModProjectDetails> {
    const projectId = expectCurseForgeId(projectValue, "CurseForge project ID");
    const [modValue, filesValue] = await Promise.all([
      this.fetchJson(this.endpoint(`mods/${projectId}`)),
      this.fetchJson(this.endpoint(`mods/${projectId}/files?pageSize=50&index=0`)),
    ]);
    return parseProjectDetails(modValue, filesValue, String(projectId), resourceType);
  }

  async resolveVersionArtifact(
    resourceType: ServerModrinthResourceType,
    projectValue: unknown,
    versionValue: unknown,
  ): Promise<ServerModArtifact> {
    const projectId = expectCurseForgeId(projectValue, "CurseForge project ID");
    const fileId = expectCurseForgeId(versionValue, "CurseForge file ID");
    const [modValue, fileValue, downloadValue] = await Promise.all([
      this.fetchJson(this.endpoint(`mods/${projectId}`)),
      this.fetchJson(this.endpoint(`mods/${projectId}/files/${fileId}`)),
      this.fetchJson(this.endpoint(`mods/${projectId}/files/${fileId}/download-url`)),
    ]);
    return parseArtifact(
      modValue,
      fileValue,
      downloadValue,
      String(projectId),
      String(fileId),
      resourceType,
    );
  }

  private async loadFilters(resourceType: ServerModrinthResourceType): Promise<ServerModFilters> {
    const classId = classIdFor(resourceType);
    try {
      const value = await this.fetchJson(
        this.endpoint(`categories?gameId=${curseForgeMinecraftGameId}&classId=${classId}`),
      );
      const record = expectRecord(value, "CurseForge categories response");
      const categories = expectArray(record.data, "CurseForge categories");
      const tags = categories
        .map((item, index) => {
          const category = expectRecord(item, `CurseForge category ${index}`);
          return {
            id: String(expectNonNegativeInteger(category.id, `CurseForge category ${index} ID`)),
            label: expectBoundedString(category.name, `CurseForge category ${index} name`, 128),
          };
        })
        .sort((left, right) => left.label.localeCompare(right.label, "en"));
      return {
        sources: [{ id: "curseforge", label: "CurseForge" }],
        tags,
        versions: [],
        loaders:
          resourceType === "mod"
            ? [...loaderNames].map((id) => ({ id, label: loaderLabels[id] ?? id }))
            : [],
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("HTTP 404")) {
        return {
          sources: [{ id: "curseforge", label: "CurseForge" }],
          tags: [],
          versions: [],
          loaders: [],
        };
      }
      throw error;
    }
  }

  private endpoint(path: string): URL {
    return new URL(path, this.baseUrl);
  }

  private async fetchJson(url: URL): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchProvider()(url, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": this.userAgent },
      });
    } catch {
      throw new CurseForgeTransientError();
    }
    if (response.status >= 500) throw new CurseForgeTransientError();
    if (response.status === 429) throw new Error("CurseForge 请求频率已达上限，请稍后重试");
    if (!response.ok) throw new Error(`CurseForge 请求失败（HTTP ${response.status}）`);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new Error("CurseForge 返回了无效的 JSON 数据");
    }
  }
}

function unavailableFilters(): ServerModFilters {
  return {
    sources: [{ id: "curseforge", label: "CurseForge" }],
    tags: [],
    versions: [],
    loaders: [],
    unavailableReason: curseForgeUnavailableReason,
  };
}

function unavailableSearchResult(request: ServerModSearchRequest): ServerModSearchResult {
  return {
    items: [],
    offset: request.offset,
    limit: 0,
    total: 0,
    unavailableReason: curseForgeUnavailableReason,
  };
}
function classIdFor(resourceType: ServerModrinthResourceType): number {
  return curseForgeMinecraftClassIds[resourceType];
}

function parseSearchResult(
  value: unknown,
  resourceType: ServerModrinthResourceType,
  expectedOffset: number,
  expectedLimit: number,
): ServerModSearchResult {
  const record = expectRecord(value, "CurseForge search result");
  const items = expectArray(record.data, "CurseForge search data");
  const pagination = expectRecord(record.pagination, "CurseForge search pagination");
  const offset = expectNonNegativeInteger(pagination.index, "CurseForge result offset");
  const limit = expectPositiveInteger(pagination.pageSize, "CurseForge result page size");
  const total = expectNonNegativeInteger(pagination.totalCount, "CurseForge result total");
  if (offset !== expectedOffset || limit !== expectedLimit || items.length > limit) {
    throw new Error("CurseForge search returned an invalid page");
  }
  return {
    items: items.flatMap((item, index) => {
      try {
        return [parseProject(item, index, resourceType)];
      } catch {
        return [];
      }
    }),
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
  const project = expectRecord(value, `CurseForge project ${index}`);
  const id = String(expectCurseForgeId(project.id, `CurseForge project ${index} ID`));
  const logo =
    project.logo === null || project.logo === undefined
      ? undefined
      : expectRecord(project.logo, "CurseForge project logo");
  const iconUrl = expectCurseForgeIconUrl(logo?.url ?? logo?.thumbnailUrl, id);
  const categories = Array.isArray(project.categories)
    ? project.categories.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const name = (item as Record<string, unknown>).name;
        return typeof name === "string" && name ? [name] : [];
      })
    : [];
  const latestFiles = Array.isArray(project.latestFilesIndexes) ? project.latestFilesIndexes : [];
  return {
    resourceType,
    source: "curseforge",
    id,
    slug: expectBoundedString(project.slug, `CurseForge project ${index} slug`, 256),
    title: expectBoundedString(project.name, `CurseForge project ${index} name`, 256),
    ...(iconUrl ? { iconUrl } : {}),
    description: expectBoundedString(
      project.summary ?? "",
      `CurseForge project ${index} summary`,
      1_000,
      true,
    ),
    author: parseAuthors(project.authors),
    downloads: expectNonNegativeInteger(
      project.downloadCount ?? 0,
      `CurseForge project ${index} downloads`,
    ),
    follows: 0,
    dateModified: expectDate(project.dateModified, `CurseForge project ${index} modified date`),
    environment: ["server_only"],
    categories,
    versions: latestFiles.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const version = (item as Record<string, unknown>).gameVersion;
      return typeof version === "string" && version ? [version] : [];
    }),
  };
}

function parseProjectDetails(
  modValue: unknown,
  filesValue: unknown,
  projectId: string,
  resourceType: ServerModrinthResourceType,
): ServerModProjectDetails {
  const mod = unwrapDataRecord(modValue, "CurseForge project details");
  if (String(expectCurseForgeId(mod.id, "CurseForge project details ID")) !== projectId) {
    throw new Error("CurseForge project details do not match the request");
  }
  return {
    resourceType,
    source: "curseforge",
    projectId,
    body: expectBoundedString(mod.summary ?? "", "CurseForge project summary", 200_000, true),
    versions: parseFilesResponse(filesValue).map((file, index) =>
      parseVersion(file, index, projectId, resourceType),
    ),
  };
}

function parseVersion(
  value: Record<string, unknown>,
  index: number,
  projectId: string,
  resourceType: ServerModrinthResourceType,
): ServerModVersion {
  const file = parseFile(value, `CurseForge project file ${index}`);
  if (String(file.modId) !== projectId)
    throw new Error("CurseForge file belongs to another project");
  return {
    id: String(file.id),
    gameVersions: parseGameVersions(file.gameVersions),
    loaders: parseLoaders(file.gameVersions, file.sortableGameVersions),
    fileName: expectResourceFileName(file.fileName, resourceType),
    downloads: expectNonNegativeInteger(file.downloadCount ?? 0, "CurseForge file downloads"),
    datePublished: expectDate(file.fileDate, "CurseForge file date"),
  };
}

function parseArtifact(
  modValue: unknown,
  fileValue: unknown,
  downloadValue: unknown,
  projectId: string,
  fileId: string,
  resourceType: ServerModrinthResourceType,
): ServerModArtifact {
  const mod = unwrapDataRecord(modValue, "CurseForge download project");
  if (String(expectCurseForgeId(mod.id, "CurseForge download project ID")) !== projectId) {
    throw new Error("CurseForge project does not match the requested project");
  }
  if (mod.allowModDistribution === false || mod.isAvailable === false) {
    throw new Error("CurseForge project is not available for distribution");
  }
  const file = parseFile(parseFileResponse(fileValue), "CurseForge download file");
  if (String(file.id) !== fileId || String(file.modId) !== projectId) {
    throw new Error("CurseForge file does not belong to the requested project");
  }
  const downloadRecord = expectRecord(downloadValue, "CurseForge download URL response");
  const downloadUrl = expectHttpsUrl(downloadRecord.data, "CurseForge download URL");
  return {
    source: "curseforge",
    resourceType,
    projectId,
    versionId: fileId,
    fileName: expectResourceFileName(file.fileName, resourceType),
    url: toCurseForgeMirrorFileUrl(downloadUrl, String(file.fileName)),
    ...(parseSha1(file.hashes) ? { sha1: parseSha1(file.hashes) } : {}),
    size: expectNonNegativeInteger(file.fileLength ?? 0, "CurseForge file size"),
    gameVersions: parseGameVersions(file.gameVersions),
    loaders: parseLoaders(file.gameVersions, file.sortableGameVersions),
  };
}

function parseFilesResponse(value: unknown): Record<string, unknown>[] {
  const data = Array.isArray(value) ? value : expectRecord(value, "CurseForge files response").data;
  if (!Array.isArray(data)) throw new Error("CurseForge files response data must be an array");
  return data.map((item, index) => parseFileResponse(item, index));
}

function parseFileResponse(value: unknown, index = 0): Record<string, unknown> {
  const record = expectRecord(value, `CurseForge file ${index}`);
  return record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? expectRecord(record.data, `CurseForge file ${index} data`)
    : record;
}

function unwrapDataRecord(value: unknown, label: string): Record<string, unknown> {
  const record = expectRecord(value, label);
  return record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? expectRecord(record.data, `${label} data`)
    : record;
}

function parseFile(value: Record<string, unknown>, label: string): Record<string, unknown> {
  return {
    ...value,
    id: expectNonNegativeInteger(value.id, `${label} ID`),
    modId: expectNonNegativeInteger(value.modId, `${label} Mod ID`),
  };
}

function parseGameVersions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item) => {
        if (typeof item !== "string" || !item || nonVersionLabels.has(item.toLowerCase()))
          return [];
        return /^\d+\.\d+(?:\.\d+)?(?:[-\w.]*)?$/u.test(item) ? [item] : [];
      }),
    ),
  ];
}

function parseLoaders(gameVersions: unknown, sortableVersions: unknown): string[] {
  const names: string[] = [];
  if (Array.isArray(gameVersions)) {
    for (const item of gameVersions) {
      if (typeof item === "string" && loaderNames.has(item.toLowerCase()))
        names.push(item.toLowerCase());
    }
  }
  if (Array.isArray(sortableVersions)) {
    for (const item of sortableVersions) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const name = (item as Record<string, unknown>).gameVersionName;
      if (typeof name === "string" && loaderNames.has(name.toLowerCase()))
        names.push(name.toLowerCase());
    }
  }
  return [...new Set(names)];
}

function parseAuthors(value: unknown): string {
  if (!Array.isArray(value)) return "CurseForge";
  const names = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const name = (item as Record<string, unknown>).name;
    return typeof name === "string" && name ? [name] : [];
  });
  return names.join(", ") || "CurseForge";
}

function parseSha1(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (
      record.algo === 1 &&
      typeof record.value === "string" &&
      /^[a-f0-9]{40}$/iu.test(record.value)
    ) {
      return record.value.toLowerCase();
    }
  }
  return undefined;
}

function toCurseForgeMirrorFileUrl(source: string, fileName: string): string {
  const url = new URL(source);
  if (url.hostname !== "edge.forgecdn.net" || !url.pathname.startsWith("/files/")) {
    throw new Error("CurseForge download URL is outside the trusted CDN path");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || decodeURIComponent(segments[3]!) !== fileName) {
    throw new Error("CurseForge download URL does not match the file");
  }
  return `https://mod.mcimirror.top/${segments.join("/")}`;
}

function expectCurseForgeIconUrl(value: unknown, projectId: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const icon = new URL(expectHttpsUrl(value, `CurseForge project ${projectId} icon`));
  if (icon.hostname !== "media.forgecdn.net" && icon.hostname !== "mod.mcimirror.top") {
    throw new Error("CurseForge project icon URL is outside the trusted CDN path");
  }
  return icon.href;
}

function expectHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error(`${label} is invalid`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new Error(`${label} is invalid`);
  }
  return url.href;
}

function expectResourceFileName(value: unknown, resourceType: ServerModrinthResourceType): string {
  const fileName = expectBoundedString(value, "CurseForge file name", 512);
  const lower = fileName.toLowerCase();
  const validExtension =
    resourceType === "mod"
      ? lower.endsWith(".jar")
      : lower.endsWith(".zip") || (resourceType === "modpack" && lower.endsWith(".mrpack"));
  if (!validExtension || fileName.includes("/") || fileName.includes("\\")) {
    throw new Error("CurseForge file name is invalid");
  }
  return fileName;
}

function expectCategoryId(value: string): string {
  if (!/^\d{1,10}$/u.test(value)) throw new TypeError("CurseForge category ID is invalid");
  return value;
}

function expectCurseForgeId(value: unknown, label: string): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647)
    throw new TypeError(`${label} is invalid`);
  return id;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function expectBoundedString(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value) ||
    value.length > maximumLength ||
    value.includes("\0")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function expectNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function expectPositiveInteger(value: unknown, label: string): number {
  const result = expectNonNegativeInteger(value, label);
  if (result < 1) throw new Error(`${label} must be positive`);
  return result;
}

function expectDate(value: unknown, label: string): string {
  const date = expectBoundedString(value, label, 64);
  if (Number.isNaN(Date.parse(date))) throw new Error(`${label} is invalid`);
  return date;
}

function normalizeBaseUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new TypeError(`${label} must use HTTPS`);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  url.search = "";
  url.hash = "";
  return url;
}

function sortFor(index: ServerModSearchRequest["index"]): { field: string; order: "asc" | "desc" } {
  switch (index) {
    case "newest":
      return { field: "DateCreated", order: "desc" };
    case "updated":
      return { field: "LastUpdated", order: "desc" };
    case "relevance":
      return { field: "Popularity", order: "desc" };
    default:
      return { field: "TotalDownloads", order: "desc" };
  }
}
