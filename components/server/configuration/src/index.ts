import {
  serverConfigurationContract,
  serverInstanceManagerContract,
  type ServerConfigurationService,
} from "@seashard/contracts";
import type { JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import type { ServerInstanceManagerService } from "@seashard/server-instance-manager";
import { ServerConfigurationManager, type ServerConfigurationManagerOptions } from "./manager";
import { registerServerConfigurationAgentIntegration } from "./agent-integration";

export type ServerConfigurationModuleOptions = Pick<
  ServerConfigurationManagerOptions,
  "fileSystem" | "now"
>;

export const serverConfigurationManifest: PluginManifest = {
  id: "seashard.server-configuration",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-configuration.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron", "node", "docker"],
      activationScopes: ["global"],
      permissions: [serverInstanceManagerContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/** 配置组件只通过实例组件取得受管根目录，不接受 Renderer 传入宿主绝对路径。 */
export function createServerConfigurationModule(
  options: ServerConfigurationModuleOptions = {},
): PluginModule {
  return {
    inject: [serverInstanceManagerContract],
    provides: [serverConfigurationContract],
    apply(ctx) {
      const instances = ctx.service<ServerInstanceManagerService>(serverInstanceManagerContract);
      const manager = new ServerConfigurationManager({
        listInstances: () => instances.list(),
        ...options,
      });
      // Agent 与 Host Service 共享同一 manager，目录解析、乐观锁、备份和写队列保持单一事实来源。
      registerServerConfigurationAgentIntegration(ctx, {
        list: (instanceId) => manager.list(instanceId),
        read: (instanceId, path) => manager.read(instanceId, path),
        write: (request) => manager.write(request),
      });

      ctx.provide(serverConfigurationContract, {
        list: async (instanceId) => asJsonValue(await manager.list(instanceId)),
        read: async (instanceId, path) => asJsonValue(await manager.read(instanceId, path)),
        write: async (request) => asJsonValue(await manager.write(request)),
      } satisfies Record<
        keyof ServerConfigurationService,
        (...arguments_: unknown[]) => Promise<JsonValue>
      >);
    },
  };
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export * from "./manager";

export * from "./agent-integration";
