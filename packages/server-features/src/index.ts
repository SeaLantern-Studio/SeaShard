import {
  serverCoreDownloadContract,
  serverDownloadConnectionLimits,
  serverSettingsContract,
  type ServerConsoleLine,
  type ServerCoreManagedDownloadRequest,
  type ServerSettingsClientService,
} from "@seashard/contracts";
import type { DatabaseService } from "@seashard/database";
import type { JsonValue, PluginManifest, ServiceProvider } from "@seashard/plugin-sdk";
import type { PluginKernel } from "@seashard/plugin-system";
import {
  createServerConfigurationModule,
  serverConfigurationManifest,
} from "@seashard/server-configuration";
import {
  createServerCoreSourceModule,
  serverCoreSourceContract,
  serverCoreSourceManifest,
  type ServerCoreSourceService,
} from "@seashard/server-core-source";
import {
  createServerFileManagerModule,
  serverFileManagerManifest,
} from "@seashard/server-file-manager";
import {
  createServerInstanceManagerModule,
  ServerInstanceRuntimeGate,
  serverInstanceManagerContract,
  serverInstanceManagerManifest,
  type ServerInstanceManagerService,
} from "@seashard/server-instance-manager";
import {
  createServerModSourceModule,
  defaultMcimModrinthApiBaseUrl,
  defaultMcimModrinthFileBaseUrl,
  serverModSourceManifest,
} from "@seashard/server-mod-source";
import {
  createServerPlayerManagerModule,
  serverPlayerManagerManifest,
} from "@seashard/server-player-manager";
import { createServerRuntimeModule, serverRuntimeManifest } from "@seashard/server-runtime";
import { createServerSettingsModule, serverSettingsManifest } from "@seashard/server-settings";
import { join } from "node:path";

export interface RegisterServerFeaturesOptions {
  readonly kernel: PluginKernel;
  readonly database: DatabaseService;
  readonly dataRoot: string;
  readonly seaShardVersion: string;
  readonly executionLocation: "controller" | "host";
  readonly publishConsoleLine?: (line: ServerConsoleLine) => void;
}

const fetchProvider = () => globalThis.fetch;

/**
 * 注册服务器领域的同一组内建组件。Desktop 当前仍在 Controller 中执行这组组件；独立
 * Server 则通过 Host 版本执行，使进程与本机文件在 Controller 断开后继续由 Host 持有。
 */
export async function registerServerFeatures(
  options: RegisterServerFeaturesOptions,
): Promise<void> {
  const { kernel, database, dataRoot, seaShardVersion, executionLocation, publishConsoleLine } =
    options;
  const runtimeGate = new ServerInstanceRuntimeGate();

  await kernel.registerBuiltIn({
    manifest: forExecution(serverSettingsManifest, executionLocation),
    loaders: {
      "server-settings.host": {
        load: async () =>
          createServerSettingsModule({
            defaultResourceDownloadDirectory: join(dataRoot, "resources"),
            defaultDownloadConnections: serverDownloadConnectionLimits.defaultValue,
          }),
      },
    },
    bindings: [featureBinding("core.server-settings", "server-settings.host")],
  });

  await kernel.registerBuiltIn({
    manifest: forExecution(serverCoreSourceManifest, executionLocation),
    loaders: {
      "server-core-source.host": {
        load: async () =>
          createServerCoreSourceModule({
            database,
            fetchProvider,
            iconCacheDirectory: join(dataRoot, "cache", "server-core-icons"),
          }),
      },
    },
    bindings: [featureBinding("core.server-core-source", "server-core-source.host")],
  });

  await kernel.registerBuiltIn({
    manifest: forExecution(serverInstanceManagerManifest, executionLocation),
    loaders: {
      "server-instance-manager.host": {
        load: async () =>
          createServerInstanceManagerModule({
            database,
            managedRoot: join(dataRoot, "servers"),
            runtimeGate,
            reportError: (error) =>
              console.error("Managed server instance finalization failed", error),
          }),
      },
    },
    bindings: [featureBinding("core.server-instance-manager", "server-instance-manager.host")],
  });

  await kernel.registerBuiltIn({
    manifest: forExecution(serverModSourceManifest, executionLocation),
    loaders: {
      "server-mod-source.host": {
        load: async () =>
          createServerModSourceModule({
            fetchProvider,
            userAgent: `SeaShard/${seaShardVersion}`,
            fallbackBaseUrl: defaultMcimModrinthApiBaseUrl,
            fallbackFileBaseUrl: defaultMcimModrinthFileBaseUrl,
          }),
      },
    },
    bindings: [featureBinding("core.server-mod-source", "server-mod-source.host")],
  });

  await kernel.registerBuiltIn({
    manifest: forExecution(serverConfigurationManifest, executionLocation),
    loaders: {
      "server-configuration.host": {
        load: async () => createServerConfigurationModule(),
      },
    },
    bindings: [featureBinding("core.server-configuration", "server-configuration.host")],
  });

  await kernel.registerBuiltIn({
    manifest: forExecution(serverRuntimeManifest, executionLocation),
    loaders: {
      "server-runtime.host": {
        load: async () =>
          createServerRuntimeModule({
            runtimeGate,
            ...(publishConsoleLine ? { onConsoleLine: publishConsoleLine } : {}),
            reportError: (error) => console.error("Server runtime failed", error),
          }),
      },
    },
    bindings: [featureBinding("core.server-runtime", "server-runtime.host")],
  });

  await kernel.registerBuiltIn({
    manifest: forExecution(serverFileManagerManifest, executionLocation),
    loaders: {
      "server-file-manager.host": { load: async () => createServerFileManagerModule() },
    },
    bindings: [featureBinding("core.server-file-manager", "server-file-manager.host")],
  });

  await kernel.registerBuiltIn({
    manifest: forExecution(serverPlayerManagerManifest, executionLocation),
    loaders: {
      "server-player-manager.host": { load: async () => createServerPlayerManagerModule() },
    },
    bindings: [featureBinding("core.server-player-manager", "server-player-manager.host")],
  });

  if (executionLocation === "host") registerServerCoreDownloadAdapter(kernel);
}

/**
 * Server Web 没有系统目录选择器。“另存为”会写入 Host 自己配置的资源下载目录；
 * 托管下载、任务状态和取消继续调用原有实例管理与核心源组件。
 */
function registerServerCoreDownloadAdapter(kernel: PluginKernel): void {
  const provider: ServiceProvider = {
    startManaged: async (value) => {
      const request = parseCoreDownloadRequest(value);
      const settings = kernel.service<ServerSettingsClientService>(serverSettingsContract);
      const instances = kernel.service<ServerInstanceManagerService>(serverInstanceManagerContract);
      const current = await settings.get();
      return (await instances.createManaged({
        ...request,
        connections: current.defaultDownloadConnections,
      })) as unknown as JsonValue;
    },
    saveAs: async (value) => {
      const request = parseCoreDownloadRequest(value);
      const settings = kernel.service<ServerSettingsClientService>(serverSettingsContract);
      const cores = kernel.service<ServerCoreSourceService>(serverCoreSourceContract);
      const current = await settings.get();
      return (await cores.start({
        ...request,
        destinationDirectory: current.resourceDownloadDirectory,
        connections: current.defaultDownloadConnections,
      })) as unknown as JsonValue;
    },
    listTasks: async () => {
      const cores = kernel.service<ServerCoreSourceService>(serverCoreSourceContract);
      return (await cores.listTasks()) as unknown as JsonValue;
    },
    cancel: async (taskId) => {
      if (typeof taskId !== "string" || !taskId) {
        throw new TypeError("server core download taskId must be a non-empty string");
      }
      return kernel.service<ServerCoreSourceService>(serverCoreSourceContract).cancel(taskId);
    },
  };
  kernel.registerCoreService(serverCoreDownloadContract, provider);
}

function parseCoreDownloadRequest(value: JsonValue): ServerCoreManagedDownloadRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("server core download request must be an object");
  }
  return {
    serverType: requireNonEmptyString(value.serverType, "serverType"),
    gameVersion: requireNonEmptyString(value.gameVersion, "gameVersion"),
    artifactFileName: requireNonEmptyString(value.artifactFileName, "artifactFileName"),
    destinationFileName: requireNonEmptyString(value.destinationFileName, "destinationFileName"),
  };
}

function requireNonEmptyString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`server core download ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * 内建组件尚需同时服务现有 Desktop Controller 与独立 Host。只改变内建注册副本的执行
 * 位置，不改发布清单，也不会让第三方包绕过 execution 校验。
 */
function forExecution(
  manifest: PluginManifest,
  execution: RegisterServerFeaturesOptions["executionLocation"],
): PluginManifest {
  return {
    ...manifest,
    entries: manifest.entries.map((entry) =>
      entry.runtime === "host" ? { ...entry, execution } : entry,
    ),
  };
}

function featureBinding(id: string, entryId: string) {
  return {
    id,
    entryId,
    scopeType: "global" as const,
    scopeId: "global",
    enabled: true,
    config: null,
  };
}
