import type {
  ServerModDownloadableResourceType,
  ServerModFilters,
  ServerModProjectDetails,
  ServerModSearchRequest,
  ServerModSearchResult,
  ServerModSource,
  ServerModrinthResourceType,
} from "@seashard/contracts";
import type {
  ServerModArtifact,
  ServerModCatalog,
  ServerModCatalogImplementation,
} from "./catalog-types";

/** 在 Host 内按来源分派，避免 Renderer 选择后再接触任意上游 URL。 */
export class ServerModSourceCatalog implements ServerModCatalog {
  constructor(
    private readonly modrinth: ServerModCatalogImplementation,
    private readonly curseForge: ServerModCatalogImplementation,
  ) {}

  getFilters(
    resourceType: ServerModrinthResourceType,
    source: ServerModSource,
  ): Promise<ServerModFilters> {
    return this.forSource(source).getFilters(resourceType);
  }

  search(request: ServerModSearchRequest): Promise<ServerModSearchResult> {
    return this.forSource(request.source).search(request);
  }

  getProjectDetails(
    resourceType: ServerModrinthResourceType,
    source: ServerModSource,
    projectId: string,
  ): Promise<ServerModProjectDetails> {
    return this.forSource(source).getProjectDetails(resourceType, projectId);
  }
  resolveVersionArtifact(
    resourceType: ServerModDownloadableResourceType,
    source: ServerModSource,
    projectId: string,
    versionId: string,
  ): Promise<ServerModArtifact> {
    return this.forSource(source).resolveVersionArtifact(resourceType, projectId, versionId);
  }

  private forSource(source: ServerModSource): ServerModCatalogImplementation {
    if (source === "modrinth") return this.modrinth;
    if (source === "curseforge") return this.curseForge;
    throw new TypeError("server resource source is invalid");
  }
}
