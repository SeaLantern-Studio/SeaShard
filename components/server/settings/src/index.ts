import {
  serverDownloadConnectionLimits,
  serverSettingsContract,
  type ServerSettingsSnapshot,
} from "@seashard/contracts";
import type { JsonValue, PluginManifest, PluginModule, PluginStorage } from "@seashard/plugin-sdk";

const settingsStorageKey = "settings";

export interface ServerSettingsModuleOptions {
  readonly defaultResourceDownloadDirectory: string;
  readonly defaultDownloadConnections: number;
}

export const serverSettingsManifest: PluginManifest = {
  id: "seashard.server-settings",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-settings.host",
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

/** 创建服务器设置组件；数据写入该 Runtime 独占的 SQLite 插件文档命名空间。 */
export function createServerSettingsModule(options: ServerSettingsModuleOptions): PluginModule {
  const defaults: ServerSettingsSnapshot = {
    resourceDownloadDirectory: expectString(
      options.defaultResourceDownloadDirectory,
      "defaultResourceDownloadDirectory",
    ),
    defaultDownloadConnections: expectConnections(
      options.defaultDownloadConnections,
      "defaultDownloadConnections",
    ),
  };

  return {
    provides: [serverSettingsContract],
    apply(ctx) {
      let snapshotTask = loadSnapshot(ctx.storage, defaults);
      let writeQueue: Promise<void> = Promise.resolve();

      /** 所有字段共用同一写队列，避免目录和线程数的并发保存互相覆盖。 */
      const updateSnapshot = (
        update: (current: ServerSettingsSnapshot) => ServerSettingsSnapshot,
      ): Promise<JsonValue> => {
        const task = writeQueue.then(async () => {
          const current = await snapshotTask;
          const next = update(current);
          await ctx.storage.put(settingsStorageKey, asJsonValue(next));
          snapshotTask = Promise.resolve(next);
          return asJsonValue(next);
        });
        writeQueue = task.then(
          () => undefined,
          () => undefined,
        );
        return task;
      };

      ctx.provide(serverSettingsContract, {
        get: async () => {
          await writeQueue;
          return asJsonValue(await snapshotTask);
        },
        setResourceDownloadDirectory: (value) => {
          const directory = expectString(value, "resourceDownloadDirectory");
          return updateSnapshot((current) => ({
            ...current,
            resourceDownloadDirectory: directory,
          }));
        },
        setDefaultDownloadConnections: (value) => {
          const connections = expectConnections(value, "defaultDownloadConnections");
          return updateSnapshot((current) => ({
            ...current,
            defaultDownloadConnections: connections,
          }));
        },
      });
    },
  };
}

async function loadSnapshot(
  storage: PluginStorage,
  defaults: ServerSettingsSnapshot,
): Promise<ServerSettingsSnapshot> {
  const document = await storage.get(settingsStorageKey);
  const value = document?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaults };
  const directory = Reflect.get(value, "resourceDownloadDirectory");
  const connections = Reflect.get(value, "defaultDownloadConnections");
  return {
    resourceDownloadDirectory:
      typeof directory === "string" ? directory : defaults.resourceDownloadDirectory,
    defaultDownloadConnections: isConnections(connections)
      ? connections
      : defaults.defaultDownloadConnections,
  };
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`server settings ${field} must be a string`);
  return value;
}

function expectConnections(value: unknown, field: string): number {
  if (!isConnections(value)) {
    throw new TypeError(
      `server settings ${field} must be an integer between ${serverDownloadConnectionLimits.minimum} and ${serverDownloadConnectionLimits.maximum}`,
    );
  }
  return value;
}

function isConnections(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= serverDownloadConnectionLimits.minimum &&
    (value as number) <= serverDownloadConnectionLimits.maximum
  );
}

function asJsonValue(value: ServerSettingsSnapshot): JsonValue {
  return value as unknown as JsonValue;
}
