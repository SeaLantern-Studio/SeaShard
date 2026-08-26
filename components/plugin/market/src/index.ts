import { pluginMarketContract, type PluginMarketSearchRequest } from "@seashard/contracts";
import type { JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import { PluginRegistryCatalog, type PluginRegistryCatalogOptions } from "./registry-catalog";

export const pluginMarketManifest: PluginManifest = {
  id: "seashard.plugin-market",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "plugin-market.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron", "node", "docker"],
      activationScopes: ["global"],
      permissions: [],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/** 发布独立的官方注册目录；Host 只下载静态 Release Catalog，并在本地完成搜索与分页。 */
export function createPluginMarketModule(options: PluginRegistryCatalogOptions = {}): PluginModule {
  return {
    provides: [pluginMarketContract],
    apply(ctx) {
      const catalog = new PluginRegistryCatalog(options);
      ctx.provide(pluginMarketContract, {
        search: async (request) =>
          asJsonValue(await catalog.search(request as unknown as PluginMarketSearchRequest)),
      });
    },
  };
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export * from "./registry-catalog";
