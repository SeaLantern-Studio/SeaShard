import { serverInstanceManagerContract } from "@seashard/contracts";
import type { DatabaseService } from "@seashard/database";
import type { JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import {
  serverCoreSourceContract,
  type ServerCoreSourceService,
} from "@seashard/server-core-source";
import { ServerInstanceManager } from "./manager";
import { serverInstanceDataCapsule, SQLiteServerInstanceRegistry } from "./registry";
import { registerServerInstanceAgentTools } from "./agent-tools";

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
      registerServerInstanceAgentTools(ctx, {
        listInstances: () => manager.list(),
      });
      ctx.provide(serverInstanceManagerContract, {
        createManaged: async (request) => asJsonValue(await manager.createManaged(request)),
        list: async () => asJsonValue(await manager.list()),
        contentCounts: async (instanceId) => asJsonValue(await manager.contentCounts(instanceId)),
        listMods: async (instanceId) => asJsonValue(await manager.listMods(instanceId)),
        setModDisabled: async (instanceId, relativePath, disabled) => {
          if (typeof disabled !== "boolean") {
            throw new TypeError("MOD 禁用状态必须是布尔值。");
          }
          return asJsonValue(await manager.setModDisabled(instanceId, relativePath, disabled));
        },
        deleteMod: async (instanceId, relativePath) => {
          await manager.deleteMod(instanceId, relativePath);
          return null;
        },
        ensureWorldStorageDirectory: async (instanceId) =>
          asJsonValue(await manager.ensureWorldStorageDirectory(instanceId)),
        listWorldStorage: async (instanceId) =>
          asJsonValue(await manager.listWorldStorage(instanceId)),
        listWorldDatapacks: async (instanceId, worldId) =>
          asJsonValue(await manager.listWorldDatapacks(instanceId, worldId)),
        setWorldDatapackDisabled: async (instanceId, worldId, fileName, disabled) => {
          if (typeof disabled !== "boolean") {
            throw new TypeError("数据包禁用状态必须是布尔值。");
          }
          return asJsonValue(
            await manager.setWorldDatapackDisabled(instanceId, worldId, fileName, disabled),
          );
        },
        deleteWorldDatapack: async (instanceId, worldId, fileName) => {
          await manager.deleteWorldDatapack(instanceId, worldId, fileName);
          return null;
        },
        listWorldBackups: async (instanceId, worldId) =>
          asJsonValue(await manager.listWorldBackups(instanceId, worldId)),
        createWorldBackup: async (instanceId, worldId) =>
          asJsonValue(await manager.createWorldBackup(instanceId, worldId)),
        restoreWorldBackup: async (instanceId, worldId, fileName) =>
          asJsonValue(await manager.restoreWorldBackup(instanceId, worldId, fileName)),
        deleteWorldBackup: async (instanceId, worldId, fileName) => {
          await manager.deleteWorldBackup(instanceId, worldId, fileName);
          return null;
        },
        switchWorld: async (instanceId, worldId) =>
          asJsonValue(await manager.switchWorld(instanceId, worldId)),
        setStartupSettings: async (instanceId, settings) =>
          asJsonValue(await manager.setStartupSettings(instanceId, settings)),
        setIcon: async (instanceId, iconDataUrl) =>
          asJsonValue(await manager.setIcon(instanceId, iconDataUrl)),
        recordResourceSource: async (instanceId, record) => {
          await manager.recordResourceSource(instanceId, record);
          return null;
        },

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

export * from "./agent-tools";
export * from "./manager";
export * from "./directory-naming";
export * from "./world-backup";
export * from "./world-storage";
export * from "./world-datapacks";
export * from "./mod-files";
export * from "./mod-metadata";
export * from "./manifest";
export * from "./resource-source-index";
export * from "./startup-settings";
export * from "./registry";
export * from "./types";
