import { serverInstanceManagerContract } from "@seashard/contracts";
import type { DatabaseService } from "@seashard/database";
import type { JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import {
  serverCoreSourceContract,
  type ServerCoreSourceService,
} from "@seashard/server-core-source";
import { ServerInstanceManager } from "./manager";
import { serverInstanceDataCapsule, SQLiteServerInstanceRegistry } from "./registry";

export interface ServerInstanceManagerModuleOptions {
  readonly database: DatabaseService;
  readonly managedRoot: string;
  readonly reportError?: (error: unknown) => void;
}

export const serverInstanceManagerManifest: PluginManifest = {
  id: "seashard.server-instance-manager",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-instance-manager.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron", "node", "docker"],
      activationScopes: ["global"],
      permissions: [serverCoreSourceContract],
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/** 创建实例管理组件；双 JSON 是实体源，SQLite 只保存 seashard.json 路径索引。 */
export function createServerInstanceManagerModule(
  options: ServerInstanceManagerModuleOptions,
): PluginModule {
  return {
    inject: [serverCoreSourceContract],
    provides: [serverInstanceManagerContract],
    async apply(ctx) {
      const repository = await options.database.registerCapsule(serverInstanceDataCapsule);
      const registry = new SQLiteServerInstanceRegistry(repository);
      const coreSource = ctx.service<ServerCoreSourceService>(serverCoreSourceContract);
      const manager = new ServerInstanceManager({
        managedRoot: options.managedRoot,
        registry,
        coreSource,
        ...(options.reportError ? { reportError: options.reportError } : {}),
      });
      ctx.provide(serverInstanceManagerContract, {
        createManaged: async (request) => asJsonValue(await manager.createManaged(request)),
        list: async () => asJsonValue(await manager.list()),
        contentCounts: async (instanceId) => asJsonValue(await manager.contentCounts(instanceId)),
        setStartupSettings: async (instanceId, settings) =>
          asJsonValue(await manager.setStartupSettings(instanceId, settings)),
        recordStartedAt: async (instanceId, startedAt) => {
          await manager.recordStartedAt(instanceId, startedAt);
          return null;
        },
        recordRuntime: async (instanceId, startedAt, stoppedAt) => {
          await manager.recordRuntime(instanceId, startedAt, stoppedAt);
          return null;
        },
        delete: async (instanceId) => {
          await manager.delete(instanceId);
          return null;
        },
        resolveIconPath: async (instanceId) =>
          asJsonValue(await manager.resolveIconPath(instanceId)),
      });
      return () => manager.dispose();
    },
  };
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export * from "./manager";
export * from "./manifest";
export * from "./startup-settings";
export * from "./registry";
export * from "./types";
