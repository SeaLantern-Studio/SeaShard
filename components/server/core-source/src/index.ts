import { downloadContract, type DownloadService } from "@seashard/download";
import type { DatabaseService } from "@seashard/database";
import type { JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import { CnbServerCoreCatalog, type CnbServerCoreCatalogOptions } from "./cnb-catalog";
import { serverCoreSourceCatalogDataCapsule, SQLiteCnbCatalogCache } from "./catalog-cache";
import { ServerCoreSourceCoordinator } from "./coordinator";
import { ServerCoreIconCache } from "./icon-cache";
import { serverCoreSourceContract } from "./types";

export type ServerCoreSourceModuleOptions = Omit<CnbServerCoreCatalogOptions, "cache"> & {
  readonly database: DatabaseService;
  readonly iconCacheDirectory: string;
};

export const serverCoreSourceManifest: PluginManifest = {
  id: "seashard.server-core-source",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-core-source.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron", "node", "docker"],
      activationScopes: ["global"],
      permissions: [downloadContract],
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/** 创建服务端核心源模块，并把目录、缓存和下载协调能力发布为稳定 Service。 */
export function createServerCoreSourceModule(options: ServerCoreSourceModuleOptions): PluginModule {
  return {
    inject: [downloadContract],
    provides: [serverCoreSourceContract],
    async apply(ctx) {
      const downloads = ctx.service<DownloadService>(downloadContract);
      const repository = await options.database.registerCapsule(serverCoreSourceCatalogDataCapsule);
      const cache = new SQLiteCnbCatalogCache(repository);
      const catalog = await CnbServerCoreCatalog.create({ ...options, cache });
      const iconCache = await ServerCoreIconCache.create({
        cacheDirectory: options.iconCacheDirectory,
        downloads,
        types: await catalog.listTypes(),
        icons: await catalog.listIcons(),
      });
      const coordinator = new ServerCoreSourceCoordinator(catalog, downloads);
      // 核心源只选择 CNB 类型和版本，通用网络、进度、取消及临时文件由公共下载组件负责。
      ctx.provide(serverCoreSourceContract, {
        listTypes: async () => asJsonValue(iconCache.listTypes()),
        resolveIconPath: async (sha256) =>
          iconCache.resolvePath(expectString(sha256, "icon sha256")) ?? null,
        listVersions: async (serverType) =>
          asJsonValue(await catalog.listVersions(expectString(serverType, "serverType"))),
        listArtifacts: async (serverType, gameVersion) =>
          asJsonValue(
            await catalog.listArtifacts(
              expectString(serverType, "serverType"),
              expectString(gameVersion, "gameVersion"),
            ),
          ),
        start: async (request) => asJsonValue(await coordinator.start(request)),
        snapshot: async (taskId) =>
          asJsonValue((await coordinator.snapshot(expectString(taskId, "taskId"))) ?? null),
        wait: async (taskId) =>
          asJsonValue((await coordinator.wait(expectString(taskId, "taskId"))) ?? null),
        listTasks: async () => asJsonValue(await coordinator.listTasks()),
        cancel: (taskId) => coordinator.cancel(expectString(taskId, "taskId")),
      });
      return () => coordinator.dispose();
    },
  };
}

function expectString(value: JsonValue, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`server core source ${field} must be a non-empty string`);
  }
  return value;
}

/** 已验证的目录对象均由普通 JSON 字段组成；此处只补足 SDK 的边界类型。 */
function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export * from "./catalog-cache";
export * from "./cnb-catalog";
export * from "./coordinator";
export * from "./icon-cache";
export * from "./types";
