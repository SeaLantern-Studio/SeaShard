import type { DownloadFetchProvider } from "@seashard/download";
import type { CnbCatalogCache, CnbCatalogCacheRecord } from "./catalog-cache";
import {
  defaultCnbCatalogUrl,
  defaultCnbIconCatalogUrl,
  type ServerCoreArtifact,
  type ServerCoreType,
} from "./types";

interface CatalogData {
  readonly types: readonly string[];
  readonly versionsByType: ReadonlyMap<string, readonly string[]>;
  readonly artifactsByTypeAndVersion: ReadonlyMap<string, readonly ServerCoreArtifact[]>;
}

/** 经过来源和对象身份校验的远端核心图标。 */
export interface CnbServerCoreIcon {
  readonly serverType: string;
  readonly url: string;
  readonly sha256: string;
}

interface RemoteCatalogUpdate {
  readonly kind: "updated";
  readonly body: string;
  readonly etag?: string;
  readonly lastModified?: string;
}

interface RemoteCatalogNotModified {
  readonly kind: "not-modified";
}

type RemoteCatalogResult = RemoteCatalogUpdate | RemoteCatalogNotModified;

export interface CnbServerCoreCatalogOptions {
  readonly cache: CnbCatalogCache;
  readonly catalogUrl?: string;
  readonly iconCatalogUrl?: string;
  readonly fetchProvider?: DownloadFetchProvider;
  readonly userAgent?: string;
  readonly requestTimeoutMs?: number;
  readonly now?: () => Date;
}

const safeNamePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}\.jar$/;
const sha256PathPattern = /\/lfs\/([a-f0-9]{64})$/i;
const safeCoreTypePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const iconCatalogPathPattern = /^\/SeaLantern-studio\/ServerCore-Mirror\/-\/lfs\/([a-f0-9]{64})$/i;
const maximumCatalogBytes = 8 * 1024 * 1024;

/**
 * 从核心 SQLite 缓存提供 CNB 服务端目录。
 *
 * 创建时先读取缓存，再尝试条件更新远端；网络失败时继续使用旧缓存。查询阶段只读
 * 已经持久化并验证过的数据，不会因页面访问再次请求网络。
 */
export class CnbServerCoreCatalog {
  private readonly cache: CnbCatalogCache;
  private readonly catalogUrl: string;
  private readonly iconCatalogUrl: string;
  private readonly fetchProvider: DownloadFetchProvider;
  private readonly userAgent: string;
  private readonly requestTimeoutMs: number;
  private readonly now: () => Date;
  private data!: CatalogData;
  private types!: readonly ServerCoreType[];
  private icons!: readonly CnbServerCoreIcon[];

  private constructor(options: CnbServerCoreCatalogOptions) {
    this.cache = options.cache;
    this.catalogUrl = options.catalogUrl ?? defaultCnbCatalogUrl;
    this.iconCatalogUrl = options.iconCatalogUrl ?? defaultCnbIconCatalogUrl;
    this.fetchProvider = options.fetchProvider ?? (() => globalThis.fetch);
    this.userAgent = options.userAgent ?? "SeaShard/0.0.0 server-core-source";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.now = options.now ?? (() => new Date());
  }

  /** 完成启动更新与 SQLite 回读后再发布可查询实例。 */
  static async create(options: CnbServerCoreCatalogOptions): Promise<CnbServerCoreCatalog> {
    const catalog = new CnbServerCoreCatalog(options);
    await catalog.initialize();
    return catalog;
  }

  async listTypes(): Promise<readonly ServerCoreType[]> {
    return this.types;
  }

  async listIcons(): Promise<readonly CnbServerCoreIcon[]> {
    return this.icons;
  }

  async listVersions(serverType: string): Promise<readonly string[]> {
    const versions = this.data.versionsByType.get(serverType);
    if (!versions) throw new Error(`server core type is unavailable: ${serverType}`);
    return versions;
  }

  async listArtifacts(
    serverType: string,
    gameVersion: string,
  ): Promise<readonly ServerCoreArtifact[]> {
    if (!this.data.versionsByType.has(serverType)) {
      throw new Error(`server core type is unavailable: ${serverType}`);
    }
    const artifacts = this.data.artifactsByTypeAndVersion.get(catalogKey(serverType, gameVersion));
    if (!artifacts) {
      throw new Error(`server core version is unavailable: ${serverType} ${gameVersion}`);
    }
    return artifacts;
  }

  private async initialize(): Promise<void> {
    const cached = await this.cache.load(this.catalogUrl);
    let remote: RemoteCatalogResult | undefined;
    try {
      remote = await this.fetchRemote(this.catalogUrl, cached);
    } catch (error) {
      // 离线启动允许使用上次成功缓存；首次启动没有缓存时不能伪装成可用。
      if (!cached) {
        throw new Error(`CNB catalog is unavailable: ${formatError(error)}`, { cause: error });
      }
    }

    const fetchedAt = this.now().toISOString();
    if (remote?.kind === "updated") {
      // 先验证再写库，格式错误或被篡改的远端响应不能覆盖最后一份可用缓存。
      parseCatalogBody(remote.body);
      await this.cache.store(this.catalogUrl, {
        body: remote.body,
        fetchedAt,
        ...(remote.etag ? { etag: remote.etag } : {}),
        ...(remote.lastModified ? { lastModified: remote.lastModified } : {}),
      });
    } else if (remote?.kind === "not-modified") {
      await this.cache.touch(this.catalogUrl, fetchedAt);
    }

    // 即使刚完成更新也从数据库回读，保证运行时使用的正是持久化成功的版本。
    const persisted = await this.cache.load(this.catalogUrl);
    if (!persisted) throw new Error("CNB catalog cache is empty after startup refresh");
    this.data = parseCatalogBody(persisted.body);
    const iconArtifacts = await this.initializeIconCatalog();
    this.types = Object.freeze(this.data.types.map((id) => Object.freeze({ id })));
    this.icons = Object.freeze(
      this.data.types.flatMap((serverType) => {
        const icon = iconArtifacts.get(serverType);
        return icon ? [icon] : [];
      }),
    );
  }

  /**
   * 图标是目录的可选展示元数据。远端或缓存损坏不能阻断核心下载，已有有效缓存仍会
   * 在离线时复用；完全不可用时由 Client 组件显示文字回退。
   */
  private async initializeIconCatalog(): Promise<ReadonlyMap<string, CnbServerCoreIcon>> {
    const cached = await this.cache.load(this.iconCatalogUrl);
    try {
      const remote = await this.fetchRemote(this.iconCatalogUrl, cached);
      const fetchedAt = this.now().toISOString();
      if (remote.kind === "updated") {
        parseIconCatalogBody(remote.body);
        await this.cache.store(this.iconCatalogUrl, {
          body: remote.body,
          fetchedAt,
          ...(remote.etag ? { etag: remote.etag } : {}),
          ...(remote.lastModified ? { lastModified: remote.lastModified } : {}),
        });
      } else {
        await this.cache.touch(this.iconCatalogUrl, fetchedAt);
      }
    } catch {
      // 图标不会改变核心制品的选择、下载或完整性，失败时继续使用最后一份有效缓存。
    }

    const persisted = await this.cache.load(this.iconCatalogUrl);
    if (!persisted) return new Map();
    try {
      return parseIconCatalogBody(persisted.body);
    } catch {
      return new Map();
    }
  }

  /** 使用 ETag/Last-Modified 条件请求检查远端目录，304 时不重复传输 JSON。 */
  private async fetchRemote(
    catalogUrl: string,
    cached: CnbCatalogCacheRecord | undefined,
  ): Promise<RemoteCatalogResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    const headers = new Headers({ "User-Agent": this.userAgent });
    if (cached?.etag) headers.set("If-None-Match", cached.etag);
    if (cached?.lastModified) headers.set("If-Modified-Since", cached.lastModified);
    try {
      const response = await this.fetchProvider()(catalogUrl, {
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
      if (response.status === 304) {
        if (!cached) throw new Error("CNB catalog returned 304 without a local cache");
        return { kind: "not-modified" };
      }
      if (!response.ok) throw new Error(`CNB catalog returned HTTP ${response.status}`);
      const declaredBytes = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > maximumCatalogBytes) {
        throw new Error(`CNB catalog exceeds ${maximumCatalogBytes} bytes`);
      }
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > maximumCatalogBytes) {
        throw new Error(`CNB catalog exceeds ${maximumCatalogBytes} bytes`);
      }
      return {
        kind: "updated",
        body,
        ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
        ...(response.headers.get("last-modified")
          ? { lastModified: response.headers.get("last-modified")! }
          : {}),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("CNB catalog request timed out", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseCatalogBody(body: string): CatalogData {
  try {
    return parseCnbCatalog(JSON.parse(body));
  } catch (error) {
    throw new Error(`CNB catalog cache is invalid: ${formatError(error)}`, { cause: error });
  }
}

function parseIconCatalogBody(body: string): ReadonlyMap<string, CnbServerCoreIcon> {
  try {
    return parseCnbIconCatalog(JSON.parse(body));
  } catch (error) {
    throw new Error(`CNB icon catalog cache is invalid: ${formatError(error)}`, { cause: error });
  }
}

/** 将 CNB 的动态 JSON 结构转换为只读、可按类型和版本查询的目录。 */
export function parseCnbCatalog(value: unknown): CatalogData {
  const root = expectRecord(value, "CNB catalog");
  const types = expectUniqueStrings(root.types, "CNB catalog types");
  if (!types.length) throw new TypeError("CNB catalog contains no server core types");

  const versionsByType = new Map<string, readonly string[]>();
  const artifactsByTypeAndVersion = new Map<string, readonly ServerCoreArtifact[]>();

  for (const serverType of types) {
    const detail = expectRecord(root[serverType], `CNB catalog type ${serverType}`);
    const versions = expectUniqueStrings(detail.versions, `CNB catalog versions for ${serverType}`);
    if (!versions.length) throw new TypeError(`CNB catalog type has no versions: ${serverType}`);
    versionsByType.set(serverType, Object.freeze(versions));

    for (const gameVersion of versions) {
      const mapping = expectRecord(
        detail[gameVersion],
        `CNB catalog artifacts for ${serverType} ${gameVersion}`,
      );
      const artifacts = Object.entries(mapping).map(([fileName, rawUrl]) =>
        parseArtifact(serverType, gameVersion, fileName, rawUrl),
      );
      if (!artifacts.length) {
        throw new TypeError(`CNB catalog version has no artifacts: ${serverType} ${gameVersion}`);
      }
      artifacts.sort((left, right) => left.fileName.localeCompare(right.fileName));
      artifactsByTypeAndVersion.set(catalogKey(serverType, gameVersion), Object.freeze(artifacts));
    }
  }

  return {
    types: Object.freeze(types),
    versionsByType,
    artifactsByTypeAndVersion,
  };
}

/**
 * 校验发布的图标索引，并把 CNB OpenAPI 地址收窄成无需凭据的公开 LFS 下载地址。
 * 当前 Release 中的 api.cnb.cool 链接是对象定位信息，不能直接交给 Renderer。
 */
export function parseCnbIconCatalog(value: unknown): ReadonlyMap<string, CnbServerCoreIcon> {
  const root = expectRecord(value, "CNB icon catalog");
  const entries = Object.entries(root);
  if (!entries.length) throw new TypeError("CNB icon catalog contains no icons");

  const icons = new Map<string, CnbServerCoreIcon>();
  for (const [coreType, rawUrl] of entries) {
    if (!safeCoreTypePattern.test(coreType)) {
      throw new TypeError(`CNB icon catalog contains an unsafe core type: ${coreType}`);
    }
    if (typeof rawUrl !== "string" || !rawUrl) {
      throw new TypeError(`CNB icon catalog URL is invalid: ${coreType}`);
    }

    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "api.cnb.cool" && url.hostname !== "cnb.cool") ||
      url.username ||
      url.password
    ) {
      throw new TypeError(`CNB icon catalog has an unsupported URL: ${rawUrl}`);
    }
    const sha256 = iconCatalogPathPattern.exec(url.pathname)?.[1]?.toLowerCase();
    if (!sha256) {
      throw new TypeError(`CNB icon catalog URL has no trusted LFS identity: ${rawUrl}`);
    }

    url.hostname = "cnb.cool";
    url.port = "";
    url.hash = "";
    url.search = "";
    url.searchParams.set("name", `${coreType}.png`);
    icons.set(
      coreType,
      Object.freeze({
        serverType: coreType,
        url: url.href,
        sha256,
      }),
    );
  }
  return icons;
}

function parseArtifact(
  serverType: string,
  gameVersion: string,
  fileName: string,
  rawUrl: unknown,
): ServerCoreArtifact {
  if (!safeNamePattern.test(fileName)) {
    throw new TypeError(`CNB catalog contains an unsafe artifact name: ${fileName}`);
  }
  if (typeof rawUrl !== "string" || !rawUrl) {
    throw new TypeError(`CNB catalog artifact URL is invalid: ${serverType} ${gameVersion}`);
  }

  // LFS 路径中的哈希既是下载对象标识，也是文件落盘前的完整性校验依据。
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "cnb.cool" && !url.hostname.endsWith(".cnb.cool"))
  ) {
    throw new TypeError(`CNB catalog artifact has an unsupported origin: ${url.origin}`);
  }
  const hash = sha256PathPattern.exec(url.pathname)?.[1]?.toLowerCase();
  if (!hash) throw new TypeError(`CNB catalog artifact URL has no SHA-256 identity: ${rawUrl}`);
  const requestedName = url.searchParams.get("name");
  if (requestedName && requestedName !== fileName) {
    throw new TypeError(`CNB catalog artifact name does not match its URL: ${fileName}`);
  }

  return Object.freeze({
    source: "cnb",
    serverType,
    gameVersion,
    fileName,
    url: url.href,
    sha256: hash,
  });
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectUniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new TypeError(`${label} must be a non-empty string array`);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains duplicates`);
  return [...result];
}

function catalogKey(serverType: string, gameVersion: string): string {
  return `${serverType}\u0000${gameVersion}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
