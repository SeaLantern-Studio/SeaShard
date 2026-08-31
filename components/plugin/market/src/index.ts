import {
  pluginMarketContract,
  pluginMarketInstallContract,
  type PluginMarketInstallRequest,
  type PluginMarketSearchRequest,
} from "@seashard/contracts";
import type { PluginKernel } from "@seashard/plugin-system";
import type { JsonValue, PluginContext, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import { registerPluginMarketAgentIntegration } from "./agent-integration";
import { PluginMarketInstaller } from "./installer";
import { PluginRegistryCatalog, type PluginRegistryCatalogOptions } from "./registry-catalog";

export const pluginMarketManifest: PluginManifest = {
  id: "seashard.plugin-market",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "plugin-market.host",
      runtime: "host",
      execution: "controller",
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

export interface PluginMarketModuleOptions extends PluginRegistryCatalogOptions {
  readonly kernel: PluginKernel;
}

/** Controller 在零 Host 状态下仍可浏览官方目录；安装能力由实际插件 Runtime 单独提供。 */
export function createPluginMarketCatalogModule(
  options: PluginRegistryCatalogOptions,
): PluginModule {
  return {
    provides: [pluginMarketContract],
    apply(ctx) {
      const catalog = new PluginRegistryCatalog(options);
      providePluginMarketCatalog(ctx, catalog);
    },
  };
}
/** 发布官方注册目录及其受限安装通道；安装地址和摘要只由 Host 从 Catalog 解析。 */
export function createPluginMarketModule(options: PluginMarketModuleOptions): PluginModule {
  return {
    provides: [pluginMarketContract, pluginMarketInstallContract],
    apply(ctx) {
      const catalog = new PluginRegistryCatalog(options);
      const installer = new PluginMarketInstaller(
        catalog,
        options.kernel,
        options.fetchProvider ? { fetchProvider: options.fetchProvider } : {},
      );
      registerPluginMarketAgentIntegration(ctx, {
        search: (request) => catalog.search(request),
        listInstalled: () => installer.list(),
        install: (request) => installer.install(request),
      });

      providePluginMarketCatalog(ctx, catalog);
      ctx.provide(pluginMarketInstallContract, {
        list: async () => asJsonValue(await installer.list()),
        install: async (request) =>
          asJsonValue(await installer.install(request as unknown as PluginMarketInstallRequest)),
      });
    },
  };
}

function providePluginMarketCatalog(context: PluginContext, catalog: PluginRegistryCatalog): void {
  context.provide(pluginMarketContract, {
    search: async (request) =>
      asJsonValue(await catalog.search(request as unknown as PluginMarketSearchRequest)),
  });
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export * from "./registry-catalog";
export * from "./installer";
export * from "./agent-integration";
