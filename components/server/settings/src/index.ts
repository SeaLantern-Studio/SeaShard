import {
  serverDownloadConnectionLimits,
  serverJvmArgumentsMaximumLength,
  serverPortLimits,
  serverSettingsContract,
  serverStartupDefaults,
  type ServerSettingsSnapshot,
  type ServerStartupDefaultsUpdate,
} from "@seashard/contracts";
import type { JsonValue, PluginManifest, PluginModule, PluginStorage } from "@seashard/plugin-sdk";
import {
  registerServerSettingsAgentIntegration,
  type ServerSettingsAgentMutationReceipt,
  type ServerSettingsAgentStartupDefaultsPatch,
} from "./agent-integration";

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
    defaultMinimumMemoryMiB: serverStartupDefaults.minimumMemoryMiB,
    defaultMaximumMemoryMiB: serverStartupDefaults.maximumMemoryMiB,
    defaultServerPort: serverStartupDefaults.port,
    autoAcceptEula: serverStartupDefaults.autoAcceptEula,
    defaultJvmArguments: serverStartupDefaults.jvmArguments,
  };

  return {
    provides: [serverSettingsContract],
    apply(ctx) {
      let snapshotTask = loadSnapshot(ctx.storage, defaults);
      let writeQueue: Promise<void> = Promise.resolve();

      const readSnapshot = async (): Promise<ServerSettingsSnapshot> => {
        await writeQueue;
        return snapshotTask;
      };

      /**
       * 所有调用方共用同一写队列，Agent 修改回执因此能在真正提交设置时捕获一致的前后快照。
       * 写入失败时保留旧 snapshotTask，后续设置操作仍可继续排队。
       */
      const updateSnapshot = (
        update: (current: ServerSettingsSnapshot) => ServerSettingsSnapshot,
      ): Promise<ServerSettingsAgentMutationReceipt> => {
        const task = writeQueue.then(async () => {
          const current = await snapshotTask;
          const next = update(current);
          await ctx.storage.put(settingsStorageKey, asJsonValue(next));
          snapshotTask = Promise.resolve(next);
          return { before: current, after: next };
        });
        writeQueue = task.then(
          () => undefined,
          () => undefined,
        );
        return task;
      };

      const setResourceDownloadDirectory = (
        value: unknown,
      ): Promise<ServerSettingsAgentMutationReceipt> => {
        const directory = expectString(value, "resourceDownloadDirectory");
        return updateSnapshot((current) => ({
          ...current,
          resourceDownloadDirectory: directory,
        }));
      };

      const setDefaultDownloadConnections = (
        value: unknown,
      ): Promise<ServerSettingsAgentMutationReceipt> => {
        const connections = expectConnections(value, "defaultDownloadConnections");
        return updateSnapshot((current) => ({
          ...current,
          defaultDownloadConnections: connections,
        }));
      };

      const setStartupDefaults = (value: unknown): Promise<ServerSettingsAgentMutationReceipt> => {
        const startupDefaults = expectStartupDefaults(value);
        return updateSnapshot((current) => ({
          ...current,
          ...startupDefaults,
        }));
      };

      /**
       * Agent 提交的是部分修改；合并和跨字段校验都在设置写队列内完成，
       * 避免与 Renderer 并发保存时用旧快照覆盖未修改字段。
       */
      const updateStartupDefaults = (
        patch: ServerSettingsAgentStartupDefaultsPatch,
      ): Promise<ServerSettingsAgentMutationReceipt> =>
        updateSnapshot((current) => ({
          ...current,
          ...expectStartupDefaults({
            defaultMinimumMemoryMiB:
              patch.defaultMinimumMemoryMiB ?? current.defaultMinimumMemoryMiB,
            defaultMaximumMemoryMiB:
              patch.defaultMaximumMemoryMiB ?? current.defaultMaximumMemoryMiB,
            defaultServerPort: patch.defaultServerPort ?? current.defaultServerPort,
            autoAcceptEula: patch.autoAcceptEula ?? current.autoAcceptEula,
            defaultJvmArguments: patch.defaultJvmArguments ?? current.defaultJvmArguments,
          }),
        }));

      registerServerSettingsAgentIntegration(ctx, {
        get: readSnapshot,
        setDefaultDownloadConnections,
        updateStartupDefaults,
      });

      ctx.provide(serverSettingsContract, {
        get: async () => asJsonValue(await readSnapshot()),
        setResourceDownloadDirectory: (value) =>
          setResourceDownloadDirectory(value).then(({ after }) => asJsonValue(after)),
        setDefaultDownloadConnections: (value) =>
          setDefaultDownloadConnections(value).then(({ after }) => asJsonValue(after)),
        setStartupDefaults: (value) =>
          setStartupDefaults(value).then(({ after }) => asJsonValue(after)),
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
  const minimumMemory = Reflect.get(value, "defaultMinimumMemoryMiB");
  const maximumMemory = Reflect.get(value, "defaultMaximumMemoryMiB");
  const defaultMinimumMemoryMiB = isPositiveSafeInteger(minimumMemory)
    ? minimumMemory
    : defaults.defaultMinimumMemoryMiB;
  const defaultMaximumMemoryMiB = isPositiveSafeInteger(maximumMemory)
    ? maximumMemory
    : defaults.defaultMaximumMemoryMiB;
  const hasValidMemoryRange = defaultMinimumMemoryMiB <= defaultMaximumMemoryMiB;
  const port = Reflect.get(value, "defaultServerPort");
  const autoAcceptEula = Reflect.get(value, "autoAcceptEula");
  const jvmArguments = Reflect.get(value, "defaultJvmArguments");
  return {
    resourceDownloadDirectory:
      typeof directory === "string" ? directory : defaults.resourceDownloadDirectory,
    defaultDownloadConnections: isConnections(connections)
      ? connections
      : defaults.defaultDownloadConnections,
    defaultMinimumMemoryMiB: hasValidMemoryRange
      ? defaultMinimumMemoryMiB
      : defaults.defaultMinimumMemoryMiB,
    defaultMaximumMemoryMiB: hasValidMemoryRange
      ? defaultMaximumMemoryMiB
      : defaults.defaultMaximumMemoryMiB,
    defaultServerPort: isPort(port) ? port : defaults.defaultServerPort,
    autoAcceptEula: typeof autoAcceptEula === "boolean" ? autoAcceptEula : defaults.autoAcceptEula,
    defaultJvmArguments: isJvmArguments(jvmArguments) ? jvmArguments : defaults.defaultJvmArguments,
  };
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`server settings ${field} must be a string`);
  return value;
}

function expectStartupDefaults(value: unknown): ServerStartupDefaultsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("server startup defaults must be an object");
  }
  const defaultMinimumMemoryMiB = expectPositiveSafeInteger(
    Reflect.get(value, "defaultMinimumMemoryMiB"),
    "defaultMinimumMemoryMiB",
  );
  const defaultMaximumMemoryMiB = expectPositiveSafeInteger(
    Reflect.get(value, "defaultMaximumMemoryMiB"),
    "defaultMaximumMemoryMiB",
  );
  if (defaultMinimumMemoryMiB > defaultMaximumMemoryMiB) {
    throw new TypeError(
      "server settings defaultMinimumMemoryMiB must not exceed defaultMaximumMemoryMiB",
    );
  }
  const autoAcceptEula = Reflect.get(value, "autoAcceptEula");
  if (typeof autoAcceptEula !== "boolean") {
    throw new TypeError("server settings autoAcceptEula must be a boolean");
  }
  return {
    defaultMinimumMemoryMiB,
    defaultMaximumMemoryMiB,
    defaultServerPort: expectPort(Reflect.get(value, "defaultServerPort")),
    autoAcceptEula,
    defaultJvmArguments: expectJvmArguments(Reflect.get(value, "defaultJvmArguments")),
  };
}

function expectPositiveSafeInteger(value: unknown, field: string): number {
  if (!isPositiveSafeInteger(value)) {
    throw new TypeError(`server settings ${field} must be a positive safe integer`);
  }
  return value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function expectPort(value: unknown): number {
  if (!isPort(value)) {
    throw new TypeError(
      `server settings defaultServerPort must be an integer between ${serverPortLimits.minimum} and ${serverPortLimits.maximum}`,
    );
  }
  return value;
}

function isPort(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= serverPortLimits.minimum &&
    (value as number) <= serverPortLimits.maximum
  );
}

function expectJvmArguments(value: unknown): string {
  if (!isJvmArguments(value)) {
    throw new TypeError(
      `server settings defaultJvmArguments must be a string without NUL characters and at most ${serverJvmArgumentsMaximumLength} characters`,
    );
  }
  return value;
}

function isJvmArguments(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= serverJvmArgumentsMaximumLength &&
    !value.includes("\0")
  );
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

export * from "./agent-integration";
