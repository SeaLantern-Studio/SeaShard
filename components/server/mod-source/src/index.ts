import { serverInstanceManagerContract, serverModSourceContract } from "@seashard/contracts";
import { downloadContract, type DownloadService } from "@seashard/download";
import type { JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import type { ServerInstanceManagerService } from "@seashard/server-instance-manager";
import { ServerModDownloadCoordinator } from "./download-coordinator";
import { ModrinthServerModCatalog, type ModrinthServerModCatalogOptions } from "./modrinth-catalog";

export type ServerModSourceModuleOptions = ModrinthServerModCatalogOptions;

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
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/** 创建独立 Modrinth 资源目录能力；网络响应在 Host 内校验后才投影给 Client。 */
export function createServerModSourceModule(options: ServerModSourceModuleOptions): PluginModule {
  return {
    inject: [downloadContract, serverInstanceManagerContract],
    provides: [serverModSourceContract],
    apply(ctx) {
      const catalog = new ModrinthServerModCatalog(options);
      const downloads = ctx.service<DownloadService>(downloadContract);
      const instances = ctx.service<ServerInstanceManagerService>(serverInstanceManagerContract);
      const coordinator = new ServerModDownloadCoordinator(catalog, downloads, instances);
      ctx.provide(serverModSourceContract, {
        getFilters: async (resourceType) => asJsonValue(await catalog.getFilters(resourceType)),
        search: async (request) => asJsonValue(await catalog.search(request)),
        getProjectDetails: async (resourceType, projectId) =>
          asJsonValue(await catalog.getProjectDetails(resourceType, projectId)),
        installToInstance: async (request) =>
          asJsonValue(await coordinator.installToInstance(request)),
        saveToDirectory: async (request) => asJsonValue(await coordinator.saveToDirectory(request)),
      });
    },
  };
}

/** Host Service 的返回值只包含经过目录解析器收窄的普通 JSON 字段。 */
function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export * from "./modrinth-catalog";
export * from "./download-coordinator";
export * from "./types";
