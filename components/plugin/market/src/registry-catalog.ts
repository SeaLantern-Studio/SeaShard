import {
  pluginMarketCatalogUrl,
  type PluginMarketCompatibility,
  type PluginMarketEntry,
  type PluginMarketPlugin,
  type PluginMarketRelease,
  type PluginMarketSearchRequest,
  type PluginMarketSearchResult,
  type PluginMarketSource,
} from "@seashard/contracts";

const defaultCacheTtlMs = 15 * 60_000;
const maximumCatalogSize = 8 * 1024 * 1024;
const maximumQueryLength = 100;
const maximumPageSize = 100;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/u;
const repositoryPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u;

type FetchProvider = () => typeof globalThis.fetch;

export interface PluginRegistryCatalogOptions {
  readonly fetchProvider?: FetchProvider;
  readonly catalogUrl?: string;
  readonly cacheTtlMs?: number;
  readonly now?: () => Date;
}

interface CatalogSnapshot {
  readonly expiresAt: number;
  readonly fetchedAt: string;
  readonly plugins: readonly PluginMarketPlugin[];
}

/**
 * 官方 Registry Release 是市场唯一发现入口。Host 每次只下载一份静态 Catalog，随后在
 * 本地完成搜索和分页；普通读取失败时可继续使用最后一次成功快照，显式刷新仍报告错误。
 */
export class PluginRegistryCatalog {
  private readonly fetchProvider: FetchProvider;
  private readonly catalogUrl: URL;
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;
  private snapshot?: CatalogSnapshot;
  private request?: Promise<CatalogSnapshot>;

  constructor(options: PluginRegistryCatalogOptions = {}) {
    this.fetchProvider = options.fetchProvider ?? (() => globalThis.fetch);
    this.catalogUrl = normalizeCatalogUrl(options.catalogUrl ?? pluginMarketCatalogUrl);
    this.cacheTtlMs = expectCacheTtl(options.cacheTtlMs ?? defaultCacheTtlMs);
    this.now = options.now ?? (() => new Date());
  }

  /** Catalog 只加载一次；查询词、分页和排序均不产生额外网络请求。 */
  async search(value: unknown): Promise<PluginMarketSearchResult> {
    const request = parseSearchRequest(value);
    const snapshot = await this.loadLingyenightbirdSnapshot(request.refresh === true);
    const plugins = filterPlugins(snapshot.plugins, request.query);
    const offset = (request.page - 1) * request.pageSize;
    return {
      totalCount: plugins.length,
      page: request.page,
      pageSize: request.pageSize,
      fetchedAt: snapshot.fetchedAt,
      plugins: plugins.slice(offset, offset + request.pageSize),
    };
  }

  /**
   * 安装路径按 Catalog 主键重新解析发布记录，Client 无法注入下载地址或摘要。
   * 这里复用与搜索相同的缓存和自动失败回退，确保列表与安装看到同一份注册目录。
   */
  async resolveRelease(
    pluginId: string,
    version: string,
  ): Promise<{ readonly plugin: PluginMarketPlugin; readonly release: PluginMarketRelease }> {
    const snapshot = await this.loadLingyenightbirdSnapshot(false);
    const plugin = snapshot.plugins.find((candidate) => candidate.id === pluginId);
    if (!plugin) throw new Error(`插件注册目录中不存在 ${pluginId}`);
    const release = plugin.releases.find((candidate) => candidate.version === version);
    if (!release) throw new Error(`插件注册目录中不存在 ${pluginId}@${version}`);
    if (release.yanked) throw new Error(`${pluginId}@${version} 已从插件市场撤回`);
    return { plugin, release };
  }

  private async loadLingyenightbirdSnapshot(forceRefresh: boolean): Promise<CatalogSnapshot> {
    const now = this.now().valueOf();
    if (!forceRefresh && this.snapshot && this.snapshot.expiresAt > now) return this.snapshot;
    if (this.request) return this.request;

    const pending = this.fetchLingyenightbirdSnapshot(now);
    this.request = pending;
    try {
      const snapshot = await pending;
      this.snapshot = snapshot;
      return snapshot;
    } catch (error) {
      if (!forceRefresh && this.snapshot) return this.snapshot;
      throw error;
    } finally {
      if (this.request === pending) this.request = undefined;
    }
  }

  private async fetchLingyenightbirdSnapshot(now: number): Promise<CatalogSnapshot> {
    const response = await this.fetchProvider()(this.catalogUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "SeaShard-Plugin-Market/1",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`插件注册目录读取失败（HTTP ${response.status}）`);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumCatalogSize) {
      throw new Error("插件注册目录超过 8 MiB");
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maximumCatalogSize) throw new Error("插件注册目录超过 8 MiB");

    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as unknown;
    } catch {
      throw new Error("插件注册目录返回了无效的 UTF-8 JSON 数据");
    }
    return {
      expiresAt: now + this.cacheTtlMs,
      fetchedAt: this.now().toISOString(),
      plugins: parseCatalog(input),
    };
  }
}

function parseCatalog(value: unknown): readonly PluginMarketPlugin[] {
  const root = expectRecord(value, "plugin catalog");
  rejectUnknown(root, ["schemaVersion", "plugins"], "plugin catalog");
  if (root.schemaVersion !== 1) throw new TypeError("plugin catalog schemaVersion must be 1");
  const plugins = expectArray(root.plugins, "plugin catalog.plugins").map((plugin, index) =>
    parsePlugin(plugin, index),
  );
  assertUnique(
    plugins.map((plugin) => plugin.id),
    "plugin catalog plugin ids",
  );
  return plugins.sort((left, right) => left.id.localeCompare(right.id));
}

function parsePlugin(value: unknown, index: number): PluginMarketPlugin {
  const path = `plugin catalog.plugins[${index}]`;
  const plugin = expectRecord(value, path);
  rejectUnknown(plugin, ["id", "name", "summary", "owners", "source", "license", "releases"], path);
  const id = expectPattern(plugin.id, `${path}.id`, pluginIdPattern);
  const releases = expectArray(plugin.releases, `${path}.releases`).map((release, releaseIndex) =>
    parseRelease(release, `${path}.releases[${releaseIndex}]`),
  );
  if (releases.length === 0) throw new TypeError(`${path}.releases must not be empty`);
  assertUnique(
    releases.map((release) => release.version),
    `${path} release versions`,
  );
  return {
    id,
    name: expectString(plugin.name, `${path}.name`),
    summary: expectString(plugin.summary, `${path}.summary`),
    owners: expectStringArray(plugin.owners, `${path}.owners`),
    source: parseSource(plugin.source, `${path}.source`),
    license: expectString(plugin.license, `${path}.license`),
    releases,
  };
}

function parseSource(value: unknown, path: string): PluginMarketSource {
  const source = expectRecord(value, path);
  rejectUnknown(source, ["type", "repository", "url"], path);
  if (source.type !== "github") throw new TypeError(`${path}.type must be github`);
  return {
    type: "github",
    repository: expectPattern(source.repository, `${path}.repository`, repositoryPattern),
    url: expectHttpsUrl(source.url, `${path}.url`),
  };
}

function parseRelease(value: unknown, path: string): PluginMarketRelease {
  const release = expectRecord(value, path);
  rejectUnknown(
    release,
    [
      "version",
      "tag",
      "releaseUrl",
      "downloadUrl",
      "archiveSha256",
      "packageDigest",
      "publisher",
      "compatibility",
      "entries",
      "fileCount",
      "unpackedSize",
      "yanked",
    ],
    path,
  );
  const entries = expectArray(release.entries, `${path}.entries`).map((entry, index) =>
    parseEntry(entry, `${path}.entries[${index}]`),
  );
  if (entries.length === 0) throw new TypeError(`${path}.entries must not be empty`);
  assertUnique(
    entries.map((entry) => entry.id),
    `${path} entry ids`,
  );
  return {
    version: expectString(release.version, `${path}.version`),
    tag: expectString(release.tag, `${path}.tag`),
    releaseUrl: expectHttpsUrl(release.releaseUrl, `${path}.releaseUrl`),
    downloadUrl: expectHttpsUrl(release.downloadUrl, `${path}.downloadUrl`),
    archiveSha256: expectPattern(release.archiveSha256, `${path}.archiveSha256`, sha256Pattern),
    packageDigest: expectPattern(release.packageDigest, `${path}.packageDigest`, sha256Pattern),
    publisher: expectPattern(release.publisher, `${path}.publisher`, pluginIdPattern),
    compatibility: parseCompatibility(release.compatibility, `${path}.compatibility`),
    entries,
    fileCount: expectPositiveInteger(release.fileCount, `${path}.fileCount`),
    unpackedSize: expectPositiveInteger(release.unpackedSize, `${path}.unpackedSize`),
    yanked: expectBoolean(release.yanked, `${path}.yanked`),
  };
}

function parseCompatibility(value: unknown, path: string): PluginMarketCompatibility {
  const compatibility = expectRecord(value, path);
  rejectUnknown(compatibility, ["seaShard", "clientProtocol"], path);
  const clientProtocol = optionalString(compatibility.clientProtocol, `${path}.clientProtocol`);
  return {
    seaShard: expectString(compatibility.seaShard, `${path}.seaShard`),
    ...(clientProtocol ? { clientProtocol } : {}),
  };
}

function parseEntry(value: unknown, path: string): PluginMarketEntry {
  const entry = expectRecord(value, path);
  rejectUnknown(entry, ["id", "runtime", "uses", "hostProfiles", "targets", "os", "arch"], path);
  if (entry.runtime !== "host" && entry.runtime !== "client") {
    throw new TypeError(`${path}.runtime must be host or client`);
  }
  const result: PluginMarketEntry = {
    id: expectPattern(entry.id, `${path}.id`, pluginIdPattern),
    runtime: entry.runtime,
    uses: parseUses(entry.uses, `${path}.uses`),
    ...(entry.hostProfiles === undefined
      ? {}
      : {
          hostProfiles: expectEnumArray(entry.hostProfiles, `${path}.hostProfiles`, [
            "electron",
            "node",
            "docker",
          ] as const),
        }),
    ...(entry.targets === undefined
      ? {}
      : {
          targets: expectEnumArray(entry.targets, `${path}.targets`, [
            "desktop",
            "web",
            "mobile",
          ] as const),
        }),
    ...(entry.os === undefined
      ? {}
      : {
          os: expectEnumArray(entry.os, `${path}.os`, [
            "win32",
            "darwin",
            "linux",
            "aix",
            "freebsd",
            "openbsd",
            "sunos",
          ] as const),
        }),
    ...(entry.arch === undefined
      ? {}
      : {
          arch: expectEnumArray(entry.arch, `${path}.arch`, [
            "x64",
            "arm64",
            "ia32",
            "arm",
            "riscv64",
            "ppc64",
            "s390x",
          ] as const),
        }),
  };
  if (result.runtime === "host" && (!result.hostProfiles || result.targets)) {
    throw new TypeError(`${path} has invalid Host platform fields`);
  }
  if (result.runtime === "client" && (!result.targets || result.hostProfiles)) {
    throw new TypeError(`${path} has invalid Client platform fields`);
  }
  return result;
}

function parseUses(value: unknown, path: string): Readonly<Record<string, readonly string[]>> {
  const source = expectRecord(value, path);
  const uses: Record<string, readonly string[]> = {};
  for (const contract of Object.keys(source)) {
    uses[contract] = expectStringArray(source[contract], `${path}.${contract}`);
  }
  return uses;
}

function parseSearchRequest(value: unknown): PluginMarketSearchRequest {
  const request = expectRecord(value, "plugin market search request");
  rejectUnknown(request, ["query", "page", "pageSize", "refresh"], "plugin market search request");
  const query = expectStringAllowEmpty(request.query, "plugin market query").trim();
  if (query.length > maximumQueryLength || query.includes("\0")) {
    throw new TypeError(
      `plugin market query must contain at most ${maximumQueryLength} characters`,
    );
  }
  const page = expectPositiveInteger(request.page, "plugin market page");
  const pageSize = expectPositiveInteger(request.pageSize, "plugin market page size");
  if (pageSize > maximumPageSize) {
    throw new TypeError(`plugin market page size must not exceed ${maximumPageSize}`);
  }
  if (!Number.isSafeInteger((page - 1) * pageSize)) {
    throw new TypeError("plugin market page offset exceeds the safe integer range");
  }
  if (request.refresh !== undefined && typeof request.refresh !== "boolean") {
    throw new TypeError("plugin market refresh must be a boolean");
  }
  return {
    query,
    page,
    pageSize,
    ...(request.refresh === undefined ? {} : { refresh: request.refresh }),
  };
}

function filterPlugins(
  plugins: readonly PluginMarketPlugin[],
  query: string,
): readonly PluginMarketPlugin[] {
  const terms = query.toLocaleLowerCase("en-US").split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return plugins;
  return plugins.filter((plugin) => {
    const searchable = [
      plugin.id,
      plugin.name,
      plugin.summary,
      plugin.license,
      plugin.source.repository,
      ...plugin.owners,
      ...plugin.releases.flatMap((release) => [release.version, release.publisher]),
    ]
      .join("\n")
      .toLocaleLowerCase("en-US");
    return terms.every((term) => searchable.includes(term));
  });
}

function normalizeCatalogUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new TypeError("plugin catalog URL must use HTTPS");
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

function expectCacheTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("plugin market cache TTL must be a non-negative safe integer");
  }
  return value;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length)
    throw new TypeError(`${label} contains unknown fields: ${unknown.join(", ")}`);
}

function expectArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new TypeError(`${label} must be a string`);
  return value;
}

function expectStringAllowEmpty(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return expectString(value, label);
}

function expectPattern(value: unknown, label: string, pattern: RegExp): string {
  const result = expectString(value, label);
  if (!pattern.test(result)) throw new TypeError(`${label} has an invalid value`);
  return result;
}

function expectStringArray(value: unknown, label: string): readonly string[] {
  const result = expectArray(value, label).map((item, index) =>
    expectString(item, `${label}[${index}]`),
  );
  if (result.length === 0) throw new TypeError(`${label} must not be empty`);
  assertUnique(result, label);
  return result;
}

function expectEnumArray<const T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): readonly T[] {
  const result = expectArray(value, label).map((item, index) => {
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      throw new TypeError(`${label}[${index}] has an invalid value`);
    }
    return item as T;
  });
  if (result.length === 0) throw new TypeError(`${label} must not be empty`);
  assertUnique(result, label);
  return result;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function expectPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function expectHttpsUrl(value: unknown, label: string): string {
  const source = expectString(value, label);
  const url = new URL(source);
  if (url.protocol !== "https:") throw new TypeError(`${label} must use HTTPS`);
  return url.toString();
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} must be unique`);
}
