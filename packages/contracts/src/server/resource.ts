/** Modrinth 与 CurseForge 服务端资源来源 Contract；Host 完整类型由来源组件关联。 */
export const serverModSourceContract = "seashard.server-mod-source";
export type ServerModSource = "modrinth" | "curseforge";
/** 判断来源是否具备当前目录查询与详情跳转实现。 */
export function isServerModSource(value: unknown): value is ServerModSource {
  return value === "modrinth" || value === "curseforge";
}
export type ServerModrinthResourceType = "mod" | "modpack" | "datapack" | "world";
export type ServerModDownloadableResourceType = ServerModrinthResourceType;
export const serverModLoaders = ["fabric", "forge", "neoforge", "quilt"] as const;
export type ServerModLoader = (typeof serverModLoaders)[number];

const serverCoreModLoaders: Readonly<Record<string, ServerModLoader>> = {
  "arclight-fabric": "fabric",
  "arclight-forge": "forge",
  "arclight-neoforge": "neoforge",
  banner: "fabric",
  catserver: "forge",
  fabric: "fabric",
  mohist: "forge",
  neoforge: "neoforge",
  quilt: "quilt",
  spongeforge: "forge",
  youer: "neoforge",
};

/** 由核心类型确定实例实际支持的 Mod 加载器；纯插件端和原版核心返回 null。 */
export function serverModLoaderForCoreType(value: unknown): ServerModLoader | null {
  return typeof value === "string" ? (serverCoreModLoaders[value] ?? null) : null;
}
export type ServerModSearchIndex = "relevance" | "downloads" | "follows" | "newest" | "updated";
export type ServerModEnvironment =
  | "client_and_server"
  | "server_only"
  | "server_only_client_optional"
  | "dedicated_server_only"
  | "client_or_server"
  | "client_or_server_prefers_both"
  | "client_only_server_optional"
  | "client_only";

/** 搜索分页的默认值与边界；Host 会再次校验，避免 Renderer 发起无界请求。 */
export const serverModSearchLimits = {
  pageSize: 20,
  maximumPageSize: 50,
  maximumQueryLength: 200,
} as const;

export interface ServerModFilterOption {
  id: string;
  label: string;
}

/** 单个服务端资源来源的筛选元数据；来源暂时不可用时保留可验证的提示。 */
export interface ServerModFilters {
  sources: readonly ServerModFilterOption[];
  tags: readonly ServerModFilterOption[];
  versions: readonly ServerModFilterOption[];
  loaders: readonly ServerModFilterOption[];
  unavailableReason?: string;
}

/** Client 只能提交声明式筛选条件，不能传入任意上游 URL 或 Facet 表达式。 */
export interface ServerModSearchRequest {
  resourceType: ServerModrinthResourceType;
  source: ServerModSource;
  query: string;
  tag: string;
  index: ServerModSearchIndex;
  gameVersion: string;
  loader: string;
  offset: number;
  limit: number;
}

/** 多来源 Mod 搜索结果的最小安全投影；图标仅允许来自受信任的上游 CDN。 */
export interface ServerModProject {
  resourceType: ServerModrinthResourceType;
  source: ServerModSource;
  id: string;
  slug: string;
  title: string;
  iconUrl?: string;
  description: string;
  author: string;
  downloads: number;
  follows: number;
  dateModified: string;
  environment: readonly ServerModEnvironment[];
  categories: readonly string[];
  versions: readonly string[];
}

export interface ServerModSearchResult {
  items: readonly ServerModProject[];
  offset: number;
  limit: number;
  total: number;
  unavailableReason?: string;
}
/** 详情页中的单个可下载版本；Host 只投影列表展示所需字段。 */
export interface ServerModVersion {
  id: string;
  gameVersions: readonly string[];
  loaders: readonly string[];
  fileName: string;
  downloads: number;
  datePublished: string;
}

/** 多来源项目长简介及其全部公开版本。 */
export interface ServerModProjectDetails {
  resourceType: ServerModrinthResourceType;
  source: ServerModSource;
  projectId: string;
  project: ServerModProject;
  body: string;
  versions: readonly ServerModVersion[];
}
export type ServerResourceSourceType = "mod" | "datapack" | "world";
export type ServerResourceSource = string;

/** 已安装资源的来源标识；未知来源只保留展示信息，不自动生成来源跳转。 */
export interface ServerResourceSourceMetadata {
  source: ServerResourceSource;
  id: string;
  /** 来源发布版本的显示标签，例如 Modrinth 的 version_number。 */
  version?: string;
  iconUrl?: string;
}

/** 实例 seashard.json 中按对应资源存储根目录的相对路径保存资源来源索引。 */
export interface ServerResourceSourceIndex {
  mods?: Readonly<Record<string, ServerResourceSourceMetadata>>;
  datapacks?: Readonly<Record<string, ServerResourceSourceMetadata>>;
  worlds?: Readonly<Record<string, ServerResourceSourceMetadata>>;
}

/** Host 写入资源来源索引时使用的单条记录。 */
export interface ServerResourceSourceRecord extends ServerResourceSourceMetadata {
  resourceType: ServerResourceSourceType;
  relativePath: string;
}

/** Renderer 只提交来源、资源类型、项目身份和已登记实例 ID；数据包还要提交已选择的存档 ID。 */
export interface ServerModInstallRequest {
  source: ServerModSource;
  resourceType: "mod" | "datapack" | "world";
  projectId: string;
  versionId: string;
  instanceId: string;
  /** 仅数据包安装使用；Host 会再次确认它属于该实例且确实存在。 */
  worldId?: string;
}

/** “另存为”同样只提交来源、资源类型和项目身份，目标目录由 Desktop 系统对话框选择。 */
export interface ServerModSaveAsRequest {
  source: ServerModSource;
  resourceType: ServerModDownloadableResourceType;
  projectId: string;
  versionId: string;
}
/** 多来源资源完成校验并发布后的稳定结果。 */
export interface ServerModDownloadResult {
  source: ServerModSource;
  resourceType: ServerModDownloadableResourceType;
  projectId: string;
  versionId: string;
  fileName: string;
  destination: "instance" | "directory";
  instanceId?: string;
  downloadedBytes: number;
}
/** 查询多来源服务端资源，并把已选择产物安装到实例或用户目录。 */
export interface ServerModSourceClientService {
  /**
   * 读取指定资源类型和来源支持的筛选项。
   *
   * @param resourceType Mod、插件、数据包或世界。
   * @param source Modrinth 或 CurseForge。
   * @returns 来源当前提供的版本、类别及加载器筛选项。
   */
  getFilters(
    resourceType: ServerModrinthResourceType,
    source: ServerModSource,
  ): Promise<ServerModFilters>;
  /**
   * 按来源语义搜索服务端资源。
   *
   * @param request 资源类型、来源、筛选条件与分页游标。
   * @returns 统一化的项目摘要和下一页状态。
   */
  search(request: ServerModSearchRequest): Promise<ServerModSearchResult>;
  /**
   * 读取来源中的项目详情和可安装版本。
   *
   * @param resourceType 目标资源类型。
   * @param source 项目所属来源。
   * @param projectId 来源分配的项目 ID。
   * @returns 统一化的项目详情及版本目录。
   */
  getProjectDetails(
    resourceType: ServerModrinthResourceType,
    source: ServerModSource,
    projectId: string,
  ): Promise<ServerModProjectDetails>;
  /**
   * 下载已选择版本并安装到已登记实例。
   *
   * @param request 来源产物身份、实例 ID 及可选世界 ID。
   * @returns 完成校验和发布后的下载结果。
   */
  installToInstance(request: ServerModInstallRequest): Promise<ServerModDownloadResult>;
  /**
   * 让用户选择目录后保存来源产物；取消目录选择时不创建文件。
   *
   * @param request 来源产物身份。
   * @returns 完成后的下载结果，用户取消时返回 undefined。
   */
  saveAs(request: ServerModSaveAsRequest): Promise<ServerModDownloadResult | undefined>;
}
