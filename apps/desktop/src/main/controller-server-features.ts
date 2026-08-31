import { serverDownloadConnectionLimits, type ServerConsoleLine } from "@seashard/contracts";
import type { SQLiteDatabaseBroker } from "@seashard/database-sqlite";
import type { PluginKernel } from "@seashard/plugin-system";
import {
  createServerConfigurationModule,
  serverConfigurationManifest,
} from "@seashard/server-configuration";
import {
  createServerCoreSourceModule,
  serverCoreSourceManifest,
} from "@seashard/server-core-source";
import {
  createServerInstanceManagerModule,
  ServerInstanceRuntimeGate,
  serverInstanceManagerManifest,
} from "@seashard/server-instance-manager";
import {
  createServerModSourceModule,
  defaultMcimModrinthApiBaseUrl,
  defaultMcimModrinthFileBaseUrl,
  serverModSourceManifest,
} from "@seashard/server-mod-source";
import { createServerRuntimeModule, serverRuntimeManifest } from "@seashard/server-runtime";
import { createServerSettingsModule, serverSettingsManifest } from "@seashard/server-settings";
import { join } from "node:path";

interface ControllerServerFeatureOptions {
  readonly kernel: PluginKernel;
  readonly database: SQLiteDatabaseBroker;
  readonly hostDataRoot: string;
  readonly seaShardVersion: string;
  readonly publishConsoleLine: (line: ServerConsoleLine) => void;
}

const fetchProvider = () => globalThis.fetch;

/**
 * 服务器类型、实例、配置、资源与启动计划都在 Controller 内解释。
 * Host 仅通过注入的下载、Java 和后续机器能力 Contract 提供设备事实与执行能力。
 */
export async function registerControllerServerFeatures(
  options: ControllerServerFeatureOptions,
): Promise<void> {
  const { kernel, database, hostDataRoot, seaShardVersion, publishConsoleLine } = options;
  const runtimeGate = new ServerInstanceRuntimeGate();

  await kernel.registerBuiltIn({
    manifest: serverSettingsManifest,
    loaders: {
      "server-settings.host": {
        load: async () =>
          createServerSettingsModule({
            defaultResourceDownloadDirectory: join(hostDataRoot, "resources"),
            defaultDownloadConnections: serverDownloadConnectionLimits.defaultValue,
          }),
      },
    },
    bindings: [controllerBinding("core.server-settings", "server-settings.host")],
  });

  await kernel.registerBuiltIn({
    manifest: serverCoreSourceManifest,
    loaders: {
      "server-core-source.host": {
        load: async () =>
          createServerCoreSourceModule({
            database,
            fetchProvider,
            iconCacheDirectory: join(hostDataRoot, "cache", "server-core-icons"),
          }),
      },
    },
    bindings: [controllerBinding("core.server-core-source", "server-core-source.host")],
  });

  await kernel.registerBuiltIn({
    manifest: serverInstanceManagerManifest,
    loaders: {
      "server-instance-manager.host": {
        load: async () =>
          createServerInstanceManagerModule({
            database,
            managedRoot: join(hostDataRoot, "servers"),
            runtimeGate,
            reportError: (error) =>
              console.error("Managed server instance finalization failed", error),
          }),
      },
    },
    bindings: [controllerBinding("core.server-instance-manager", "server-instance-manager.host")],
  });

  await kernel.registerBuiltIn({
    manifest: serverModSourceManifest,
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
    bindings: [controllerBinding("core.server-mod-source", "server-mod-source.host")],
  });

  await kernel.registerBuiltIn({
    manifest: serverConfigurationManifest,
    loaders: {
      "server-configuration.host": {
        load: async () => createServerConfigurationModule(),
      },
    },
    bindings: [controllerBinding("core.server-configuration", "server-configuration.host")],
  });

  await kernel.registerBuiltIn({
    manifest: serverRuntimeManifest,
    loaders: {
      "server-runtime.host": {
        load: async () =>
          createServerRuntimeModule({
            runtimeGate,
            onConsoleLine: publishConsoleLine,
            reportError: (error) => console.error("Server runtime failed", error),
          }),
      },
    },
    bindings: [controllerBinding("core.server-runtime", "server-runtime.host")],
  });
}

function controllerBinding(id: string, entryId: string) {
  return {
    id,
    entryId,
    scopeType: "global" as const,
    scopeId: "global",
    enabled: true,
    config: null,
  };
}
