import { pluginMarketContract, pluginMarketInstallContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const pluginMarketUiManifest: PluginManifest = {
  id: "seashard.plugin-market-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "plugin-market.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop", "web"],
      activationScopes: ["global"],
      uses: {
        [pluginMarketContract]: ["search"],
        [pluginMarketInstallContract]: ["list", "install"],
      },
      permissions: [pluginMarketContract, pluginMarketInstallContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
