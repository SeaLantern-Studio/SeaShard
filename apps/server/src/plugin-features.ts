import {
  pluginManagementContract,
  pluginManagementUiRuntimeId,
  pluginMarketInstallContract,
  pluginMarketUiRuntimeId,
} from "@seashard/contracts";
import {
  createPluginManagementModule,
  pluginManagementManifest,
} from "@seashard/plugin-management";
import { createPluginMarketModule, pluginMarketManifest } from "@seashard/plugin-market";
import type { PluginKernel } from "@seashard/plugin-system";

/** Server Controller 复用 Desktop 的插件管理语义，同时保留固定内置页面的特权边界。 */
export async function registerServerPluginFeatures(kernel: PluginKernel): Promise<void> {
  kernel.restrictServiceCalls(
    pluginManagementContract,
    (execution) =>
      execution.actorType === "client" && execution.runtimeId === pluginManagementUiRuntimeId,
  );
  kernel.restrictServiceCalls(
    pluginMarketInstallContract,
    (execution) =>
      execution.actorType === "client" && execution.runtimeId === pluginMarketUiRuntimeId,
  );

  await kernel.registerBuiltIn({
    manifest: pluginManagementManifest,
    loaders: {
      "plugin-management.host": {
        load: async () => createPluginManagementModule(kernel),
      },
    },
    bindings: [controllerBinding("core.plugin-management", "plugin-management.host")],
  });
  await kernel.registerBuiltIn({
    manifest: pluginMarketManifest,
    loaders: {
      "plugin-market.host": {
        load: async () =>
          createPluginMarketModule({
            kernel,
            fetchProvider: () => globalThis.fetch,
          }),
      },
    },
    bindings: [controllerBinding("core.plugin-market", "plugin-market.host")],
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
