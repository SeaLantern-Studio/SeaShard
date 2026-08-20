import { serverModSourceContract } from "@seashard/contracts";
import type { JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
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
      permissions: [],
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/** 创建独立 Modrinth 目录能力；网络响应在 Host 内校验后才投影给 Client。 */
export function createServerModSourceModule(options: ServerModSourceModuleOptions): PluginModule {
  return {
    inject: [],
    provides: [serverModSourceContract],
    apply(ctx) {
      const catalog = new ModrinthServerModCatalog(options);
      ctx.provide(serverModSourceContract, {
        getFilters: async () => asJsonValue(await catalog.getFilters()),
        search: async (request) => asJsonValue(await catalog.search(request)),
        getProjectDetails: async (projectId) =>
          asJsonValue(await catalog.getProjectDetails(projectId)),
      });
    },
  };
}

/** Host Service 的返回值只包含经过目录解析器收窄的普通 JSON 字段。 */
function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export * from "./modrinth-catalog";
export * from "./types";
