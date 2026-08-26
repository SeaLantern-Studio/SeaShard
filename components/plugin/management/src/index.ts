import { pluginManagementContract } from "@seashard/contracts";
import type { JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import type { PluginKernel } from "@seashard/plugin-system";

export const pluginManagementManifest: PluginManifest = {
  id: "seashard.plugin-management",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "plugin-management.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron"],
      activationScopes: ["global"],
      permissions: [],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/** 插件管理依赖 Kernel 的收敛事务，因此作为内建 Host 组件发布窄 Service。 */
export function createPluginManagementModule(kernel: PluginKernel): PluginModule {
  return {
    provides: [pluginManagementContract],
    apply(ctx) {
      ctx.provide(pluginManagementContract, {
        list: async () => (await kernel.listThirdPartyPlugins()) as unknown as JsonValue,
        setEnabled: async (pluginId, enabled) =>
          (await kernel.setThirdPartyPluginEnabled(
            pluginId as string,
            enabled as boolean,
          )) as unknown as JsonValue,
        uninstall: async (pluginId) => {
          await kernel.uninstallThirdPartyPlugin(pluginId as string);
        },
      });
    },
  };
}
