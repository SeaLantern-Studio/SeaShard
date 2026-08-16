import { serverSettingsContract, type ServerSettingsSnapshot } from "@seashard/contracts";
import type { JsonValue, PluginManifest, PluginModule, PluginStorage } from "@seashard/plugin-sdk";

const settingsStorageKey = "settings";

export interface ServerSettingsModuleOptions {
  readonly defaultResourceDownloadDirectory: string;
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
  };

  return {
    provides: [serverSettingsContract],
    apply(ctx) {
      let snapshotTask = loadSnapshot(ctx.storage, defaults);
      let writeQueue: Promise<void> = Promise.resolve();

      ctx.provide(serverSettingsContract, {
        get: async () => {
          await writeQueue;
          return asJsonValue(await snapshotTask);
        },
        setResourceDownloadDirectory: (value) => {
          const directory = expectString(value, "resourceDownloadDirectory");
          const task = writeQueue.then(async () => {
            await snapshotTask;
            const next: ServerSettingsSnapshot = { resourceDownloadDirectory: directory };
            await ctx.storage.put(settingsStorageKey, asJsonValue(next));
            snapshotTask = Promise.resolve(next);
            return asJsonValue(next);
          });
          writeQueue = task.then(
            () => undefined,
            () => undefined,
          );
          return task;
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
  return typeof directory === "string" ? { resourceDownloadDirectory: directory } : { ...defaults };
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`server settings ${field} must be a string`);
  return value;
}

function asJsonValue(value: ServerSettingsSnapshot): JsonValue {
  return value as unknown as JsonValue;
}
