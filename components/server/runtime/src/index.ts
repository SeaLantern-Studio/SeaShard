import {
  javaRuntimeManagerContract,
  serverInstanceManagerContract,
  serverRuntimeContract,
  serverSettingsContract,
  type JavaRuntimeManagerService,
  type ServerConsoleLine,
  type ServerRuntimeService,
  type ServerSettingsClientService,
} from "@seashard/contracts";
import type { JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import type { ServerInstanceManagerService } from "@seashard/server-instance-manager";
import { ServerRuntimeManager, type ServerRuntimeManagerOptions } from "./manager";

export interface ServerRuntimeModuleOptions {
  onConsoleLine?(line: ServerConsoleLine): void;
  reportError?(error: unknown): void;
  managerOptions?: Pick<
    ServerRuntimeManagerOptions,
    "spawnProcess" | "fileSystem" | "now" | "stopGracePeriodMs"
  >;
}

export const serverRuntimeManifest: PluginManifest = {
  id: "seashard.server-runtime",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-runtime.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron", "node", "docker"],
      activationScopes: ["global"],
      permissions: [
        serverInstanceManagerContract,
        javaRuntimeManagerContract,
        serverSettingsContract,
      ],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/** 创建多核心服务器运行组件；实例、Java 与启动默认值均来自显式 Contract。 */
export function createServerRuntimeModule(options: ServerRuntimeModuleOptions = {}): PluginModule {
  return {
    inject: [serverInstanceManagerContract, javaRuntimeManagerContract, serverSettingsContract],
    provides: [serverRuntimeContract],
    apply(ctx) {
      const instances = ctx.service<ServerInstanceManagerService>(serverInstanceManagerContract);
      const javaRuntime = ctx.service<JavaRuntimeManagerService>(javaRuntimeManagerContract);
      const settings = ctx.service<ServerSettingsClientService>(serverSettingsContract);
      const manager = new ServerRuntimeManager({
        listInstances: () => instances.list(),
        recordInstanceStartedAt: (instanceId, startedAt) =>
          instances.recordStartedAt(instanceId, startedAt),
        recordInstanceRuntime: (instanceId, startedAt, stoppedAt) =>
          instances.recordRuntime(instanceId, startedAt, stoppedAt),
        scanJavaInstallations: () => javaRuntime.scan(),
        readSettings: () => settings.get(),
        ...(options.onConsoleLine
          ? { onConsoleLine: (line: ServerConsoleLine) => options.onConsoleLine!(line) }
          : {}),
        ...(options.reportError
          ? { reportError: (error: unknown) => options.reportError!(error) }
          : {}),
        ...options.managerOptions,
      });

      ctx.provide(serverRuntimeContract, {
        preview: async (instanceId, startupSettings) =>
          asJsonValue(await manager.preview(instanceId, startupSettings)),
        get: async (instanceId) => asJsonValue(manager.get(instanceId)),
        start: async (instanceId) => asJsonValue(await manager.start(instanceId)),
        stop: async (instanceId) => asJsonValue(await manager.stop(instanceId)),
        sendCommand: async (instanceId, command) => {
          await manager.sendCommand(instanceId, command);
          return null;
        },
        getLogs: async (instanceId, afterSequence = 0) =>
          asJsonValue(manager.getLogs(instanceId, afterSequence)),
      } satisfies Record<
        keyof ServerRuntimeService,
        (...arguments_: unknown[]) => Promise<JsonValue>
      >);

      return () => manager.dispose();
    },
  };
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export * from "./manager";
export * from "./filesystem";
export * from "./process";
export * from "./preparation-runner";
export * from "./runtime-files";
export * from "./profiles";
