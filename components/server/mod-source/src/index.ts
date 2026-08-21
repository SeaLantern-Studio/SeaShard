import {
  serverInstanceManagerContract,
  serverModSourceContract,
  type ServerModSearchRequest,
  type ServerModSource,
  type ServerModrinthResourceType,
} from "@seashard/contracts";
import { downloadContract, type DownloadService } from "@seashard/download";
import type { JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import type { ServerInstanceManagerService } from "@seashard/server-instance-manager";
import {
  CurseForgeServerModCatalog,
  type CurseForgeServerModCatalogOptions,
} from "./curseforge-catalog";
import { ServerModDownloadCoordinator } from "./download-coordinator";
import { ModrinthServerModCatalog, type ModrinthServerModCatalogOptions } from "./modrinth-catalog";
import { ServerModSourceCatalog } from "./source-catalog";

export interface ServerModSourceModuleOptions extends ModrinthServerModCatalogOptions {
  readonly curseForge?: Omit<CurseForgeServerModCatalogOptions, "fetchProvider" | "userAgent">;
}

export const serverModSourceManifest: PluginManifest = {
  id: "seashard.server-mod-source",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-mod-source.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron", "node", "docker"],
      activationScopes: ["global"],
      permissions: [downloadContract, serverInstanceManagerContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/** 创建独立多来源资源目录能力；网络响应在 Host 内校验后才投影给 Client。 */
export function createServerModSourceModule(options: ServerModSourceModuleOptions): PluginModule {
  return {
    inject: [downloadContract, serverInstanceManagerContract],
    provides: [serverModSourceContract],
    apply(ctx) {
      const modrinth = new ModrinthServerModCatalog(options);
      const curseForge = new CurseForgeServerModCatalog({
        fetchProvider: options.fetchProvider,
        userAgent: options.userAgent,
        ...options.curseForge,
      });
      const catalog = new ServerModSourceCatalog(modrinth, curseForge);
      const downloads = ctx.service<DownloadService>(downloadContract);
      const instances = ctx.service<ServerInstanceManagerService>(serverInstanceManagerContract);
      const coordinator = new ServerModDownloadCoordinator(catalog, downloads, instances);
      ctx.provide(serverModSourceContract, {
        getFilters: async (resourceType, source) =>
          asJsonValue(
            await catalog.getFilters(
              resourceType as unknown as ServerModrinthResourceType,
              source as unknown as ServerModSource,
            ),
          ),
        search: async (request) =>
          asJsonValue(await catalog.search(request as unknown as ServerModSearchRequest)),
        getProjectDetails: async (resourceType, source, projectId) => {
          if (typeof projectId !== "string")
            throw new TypeError("server resource project ID is invalid");
          return asJsonValue(
            await catalog.getProjectDetails(
              resourceType as unknown as ServerModrinthResourceType,
              source as unknown as ServerModSource,
              projectId,
            ),
          );
        },
        installToInstance: async (request) =>
          asJsonValue(await coordinator.installToInstance(request)),
        saveAs: async (request) => asJsonValue(await coordinator.saveToDirectory(request)),
      });
    },
  };
}

/** Host Service 的返回值只包含经过目录解析器收窄的普通 JSON 字段。 */
function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export * from "./modrinth-catalog";
export * from "./catalog-types";
export * from "./curseforge-catalog";
export * from "./source-catalog";
export * from "./download-coordinator";
export * from "./types";
