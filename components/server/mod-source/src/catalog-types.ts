import type {
  ServerModDownloadableResourceType,
  ServerModFilters,
  ServerModProjectDetails,
  ServerModSearchRequest,
  ServerModSearchResult,
  ServerModSource,
  ServerModrinthResourceType,
} from "@seashard/contracts";

/** Host 内部下载投影；Renderer 永远不能提供 URL、哈希或最终路径。 */
export interface ServerModArtifact {
  readonly source: ServerModSource;
  readonly resourceType: ServerModDownloadableResourceType;
  readonly projectId: string;
  readonly versionId: string;
  readonly fileName: string;
  readonly url: string;
  readonly fallbackUrl?: string;
  readonly sha1?: string;
  readonly sha256?: string;
  readonly sha512?: string;
  readonly size: number;
  readonly gameVersions: readonly string[];
  readonly iconUrl?: string;

  readonly loaders: readonly string[];
}

/** 已绑定单个来源的 Host 目录实现。 */
export interface ServerModCatalogImplementation {
  getFilters(resourceType: ServerModrinthResourceType): Promise<ServerModFilters>;
  search(request: ServerModSearchRequest): Promise<ServerModSearchResult>;
  getProjectDetails(
    resourceType: ServerModrinthResourceType,
    projectId: string,
  ): Promise<ServerModProjectDetails>;
  resolveVersionArtifact(
    resourceType: ServerModDownloadableResourceType,
    projectId: string,
    versionId: string,
  ): Promise<ServerModArtifact>;
}

/** 来源选择已完成的 Host 目录服务；IPC 与下载协调器只依赖这个接口。 */
export interface ServerModCatalog {
  getFilters(
    resourceType: ServerModrinthResourceType,
    source: ServerModSource,
  ): Promise<ServerModFilters>;
  search(request: ServerModSearchRequest): Promise<ServerModSearchResult>;
  getProjectDetails(
    resourceType: ServerModrinthResourceType,
    source: ServerModSource,
    projectId: string,
  ): Promise<ServerModProjectDetails>;
  resolveVersionArtifact(
    resourceType: ServerModDownloadableResourceType,
    source: ServerModSource,
    projectId: string,
    versionId: string,
  ): Promise<ServerModArtifact>;
}
